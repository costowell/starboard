import bolt from "@slack/bolt";
const { App } = bolt;
import postgres from 'postgres'
import 'dotenv/config'

const sql = postgres({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD
})

const STARBOARD_CHANNEL = process.env.STARBOARD_CHANNEL;
const REACTION_NAME = process.env.REACTION_NAME || "star";
const EMOJI = "⭐";
const BOTSPAM_CHANNEL = process.env.BOTSPAM_CHANNEL;

const CONSTRAINT_UNIQUE = "23505";

const app = new App({
  token: process.env.SLACK_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.error((error) => {
  console.error("Unhandled slack error", error);
  throw error;
});

app.start().then(() => {
  console.log("Ready!");
});

async function resolveMessage(ctx) {
  if (ctx.payload.reaction != REACTION_NAME) return;

  let messageId = ctx.payload.item.ts;
  let channel = ctx.payload.item.channel;

  if (ctx.payload.item.channel == STARBOARD_CHANNEL) {
    const response = await sql`SELECT messageId, channelId FROM posts WHERE postId = ${ctx.payload.item.ts}`;
    if (response.length > 0) {
      messageId = response[0].messageId;
      channel = response[0].channelId;
    }
  }
  const { messages } = await ctx.client.conversations.replies({
    channel,
    ts: messageId,
    latest: messageId,
    inclusive: true,
    limit: 1,
  });

  if (messages[0].ts != messageId) {
    console.error(
      "This shouldn't happen! Why are we differing TS!",
      messages[0],
      messageId
    );
  }

  // No self-starring
  if (messages[0].user == ctx.payload.user) return;

  const { user } = await ctx.client.users.info({
    user: ctx.payload.user,
  });

  // No auto-react lol
  if (user.is_bot || user.is_app_user) {
    console.log("Ignoring bot!", user);
    return;
  }

  return {
    channel,
    messageId,
    authorId: messages[0].user,
    message: messages[0],
  };
}

app.event("reaction_added", async (ctx) => {
  const resolution = await resolveMessage(ctx);
  if (!resolution) return;

  console.log("Star reaction added");

  try {
    await sql`INSERT INTO stars (messageId, authorId, channelId) VALUES (${resolution.messageId}, ${ctx.payload.user}, ${resolution.channel})`;
  } catch (err) {
    if (err.code == CONSTRAINT_UNIQUE) {
      return;
    } else {
      throw err;
    }
  }

  try {
    await sql`INSERT INTO tips (tipId, userId) VALUES ('first_star', ${ctx.payload.user})`;
    try {
      await ctx.client.chat.postMessage({
        channel: ctx.payload.user,
        text: `Psst! You added your first ${EMOJI} to a message! Sometimes people add ${EMOJI}s to things because they don't understand what they mean, so that's where this tip comes in!

Adding a ${EMOJI} to a message is sorta like an upvote of a message you think is funny. Think of them like democratized pins, but without the limit. Messages which reach a certain threshold of ${EMOJI}s get posted in <#${STARBOARD_CHANNEL}>!

You're free to participate by ${EMOJI}-ing messages as you wish without being in the channel-I'll only post this tip once!`,
      });
    } catch (err) {
      console.error(`Couldn't PM ${ctx.payload.user} tip!`, err);
    }
  } catch (err) {
    // Already has tip!
    if (err.code != CONSTRAINT_UNIQUE) {
      throw err;
    }
  }

  await updateStarboard({
    messageId: resolution.messageId,
    channelId: resolution.channel,
    authorId: resolution.authorId,
    message: resolution.message,
    client: ctx.client,
  });
});

app.event("reaction_removed", async (ctx) => {
  const resolution = await resolveMessage(ctx);
  if (!resolution) return;


  await sql`DELETE FROM stars WHERE messageId = ${resolution.messageId} AND authorId = ${ctx.payload.user} AND channelId = ${resolution.channel}`;
  console.log("Star reaction removed");

  await updateStarboard({
    messageId: resolution.messageId,
    channelId: resolution.channel,
    authorId: resolution.authorId,
    message: resolution.message,
    client: ctx.client,
  });
});

app.shortcut("reload_stars", async (ctx) => {
  console.log("Reload stars called");

  await ctx.ack();

  if (ctx.payload.channel.id == STARBOARD_CHANNEL) {
    console.log("Ignoring request to reload stars on starboard channel");
    return;
  }

  // Just in case I get resolveMessage() working for this...
  const message = ctx.payload.message;
  const resolution = {
    messageId: message.ts,
    message,
    authorId: message.user,
    channel: ctx.payload.channel.id,
  };

  const reactions = await ctx.client.reactions.get({
    full: true,
    channel: resolution.channel,
    timestamp: resolution.messageId,
  });

  const star = reactions.message.reactions?.find(
    (reaction) => reaction.name == REACTION_NAME
  );

  const users = new Set(star?.users);

  let postId = await sql`SELECT postId FROM posts WHERE messageId = ${resolution.messageId}`;

  if (postId.length > 0) {
    const channelReactions = await ctx.client.reactions.get({
      full: true,
      channel: STARBOARD_CHANNEL,
      timestamp: postId[0],
    });
    const star = channelReactions.message.reactions?.find(
      (reaction) => reaction.name == REACTION_NAME
    );
    if (star) {
      for (const user of star.users) {
        users.add(user);
      }
    }
  }

  // Get rid of old stars:
  await sql`DELETE FROM stars WHERE messageId = ${resolution.messageId} AND channelId = ${resolution.channel}`

  for (const user of users) {
    // No self-starring
    if (user == message.user) continue;
    try {
      await sql`INSERT INTO stars (messageId, authorId, channelId) VALUES (${resolution.messageId}, ${user}, ${resolution.channel})`;
    } catch (err) {
      if (err.code != "SQLITE_CONSTRAINT_UNIQUE") {
        throw err;
      }
    }
  }

  await updateStarboard({
    messageId: resolution.messageId,
    channelId: resolution.channel,
    authorId: resolution.authorId,
    message: resolution.message,
    client: ctx.client,
  });
});

async function updateStarboard({
  messageId,
  authorId,
  channelId,
  message,
  client,
}) {
  const postId = await sql`SELECT postId FROM posts WHERE messageId = ${messageId}`
  let count = await sql`SELECT COUNT(*) FROM stars WHERE messageId = ${messageId}`;
  count = count.length > 0 ? count[0].count : 0;

  console.log(count, postId);

  const minimumStarCount = message.thread_ts ? 1 : 3;
  if (count >= minimumStarCount) {
    const { permalink } = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageId,
    });
    const content = `${EMOJI} *${count}* <#${channelId}>

${permalink}`;
    if (postId.length > 0) {
      await client.chat.update({
        channel: STARBOARD_CHANNEL,
        ts: postId[0],
        text: content,
      });
    } else {
      const response = await client.chat.postMessage({
        channel: STARBOARD_CHANNEL,
        text: content,
      });
      try {
        await sql`INSERT INTO tips (tipId, userId) VALUES ('entered_starboard', ${authorId})`;
        try {
          await client.chat.postMessage({
            channel: authorId,
            text: `Congratulations on your newfound <#${STARBOARD_CHANNEL}> fame! Your message got ${count} ${EMOJI}s, meaning people thought it was funny! Think of <#${STARBOARD_CHANNEL}> as democratized pins but without being limited arbitrarily!

Feel free to join <#${STARBOARD_CHANNEL}> to look at other people's ${EMOJI}'d posts! I'll only post this tip once, so don't worry about joining if you don't want to :)`,
          });
        } catch (err) {
          console.error(`Couldn't PM ${authorId} tip!`, err);
        }
      } catch (err) {
        if (err.code != CONSTRAINT_UNIQUE) {
          throw err;
        }
      }
      let r = await sql`INSERT INTO posts (messageId, channelId, postId, authorId) VALUES (${messageId}, ${channelId}, ${response.message.ts}, ${authorId})`
      console.log({ r })
    }
  } else if (postId.length > 0) {
    await client.chat.delete({
      channel: STARBOARD_CHANNEL,
      ts: postId[0],
    });
    await sql`DELETE FROM posts WHERE messageId = ${messageId}`
  }
}

function topUsers(sectionTitle, users) {
  console.log(users);
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: sectionTitle,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: users.map((user) => ({
        type: "mrkdwn",
        text: `<@${user.authorid}> — ${user.count} ${EMOJI}`,
      })),
    },
  ];
}

app.command("/stargazers", async ({ command, ack, client, respond, payload }) => {
  await ack();

  if (payload.channel_id != BOTSPAM_CHANNEL) {
    await respond(`This command is only allowed in <#${BOTSPAM_CHANNEL}>!`);
    return;
  }

  const topAuthors = await sql`
    SELECT posts.authorId, COUNT(*) AS count
    FROM stars
    LEFT JOIN posts ON stars.messageid = posts.messageid
    WHERE posts.authorId IS NOT NULL
    GROUP BY posts.authorId
    ORDER BY count DESC
    LIMIT 10
  `;
  const topStarrers = await sql`SELECT authorId, COUNT(*) as count FROM stars GROUP BY authorId ORDER BY count desc LIMIT 10`;
  const topPosts = await sql`SELECT posts.authorId, posts.channelId, posts.messageId, COUNT(stars.authorId) AS count FROM posts JOIN stars ON stars.messageId = posts.messageId GROUP BY posts.messageId ORDER BY count DESC LIMIT 5`;

  console.log({ topAuthors, topStarrers, topPosts })

  await respond({
    response_type: "in_channel",
    blocks: [
      ...topUsers("Top 10 Star Receivers", topAuthors),
      ...topUsers("Top 10 Starrers (Wall of Shame)", topStarrers),
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Top 5 Starred Posts",
          emoji: true,
        },
      },
      ...(await Promise.all(
        topPosts.map(async (post) => [
          {
            type: "divider",
          },
          {
            type: "section",
            fields: [
              {
                type: "mrkdwn",
                text: `${EMOJI} *${post.count}* <#${post.channelid}> — <@${post.authorid
                  }>: ${await getPermalink(
                    post.channelid,
                    post.messageid,
                    client
                  )}`,
              },
            ],
          },
        ])
      ).then((posts) => posts.flat())),
    ],
  });
});

async function getPermalink(channelId, messageId, client) {
  console.log({ channelId, messageId })
  const { permalink } = await client.chat.getPermalink({
    channel: channelId,
    message_ts: messageId,
  });
  return permalink;
}
