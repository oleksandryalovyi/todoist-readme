const core = require("@actions/core");
const axios = require("axios");
const Humanize = require("humanize-plus");
const fs = require("fs");
const os = require("os");
const exec = require("./exec");

const HABITICA_USER_ID = core.getInput("HABITICA_USER_ID");
const HABITICA_TOKEN = core.getInput("HABITICA_TOKEN");
const GITHUB_TOKEN = core.getInput("GITHUB_TOK") || process.env.GITHUB_TOKEN;

const habiticaHeaders = {
  "X-Client": `${HABITICA_USER_ID}-action`,
  "x-api-key": HABITICA_TOKEN,
  "x-api-user": HABITICA_USER_ID,
};

async function fetchHabiticaData() {
  try {
    await axios.get("https://habitica.com/api/v3/tasks/user?type=dailys", {
      headers: habiticaHeaders,
    });
  } catch (err) {
    console.error(err);
    core.error(
      `Failed to fetch dailies data from Habitica API: ${err.message}`,
    );
    jobFailFlag = true;
  }

  const [dailiesResponse, todosResponse] = await Promise.all([
    axios.get("https://habitica.com/api/v3/tasks/user?type=dailys", {
      headers: habiticaHeaders,
    }),
    axios.get("https://habitica.com/api/v3/tasks/user?type=completedTodos", {
      headers: habiticaHeaders,
    }),
  ]);

  return {
    dailies: dailiesResponse.data.data,
    todos: todosResponse.data.data,
  };
}

async function main() {
  const { dailies, todos } = await fetchHabiticaData();
  const stats = calculateStats(dailies, todos);
  await updateReadme(stats);
}

function calculateStats(dailies, todos) {
  // Dailies stats
  const completedDailiesToday = dailies.filter((d) => d.completed).length;

  const now = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(now.getDate() - 7);

  const completedDailiesWeek = dailies.reduce((sum, task) => {
    const count = (task.history || []).filter((entry) => {
      const date = new Date(entry.date);
      return date >= weekAgo && entry.value > 0;
    }).length;
    return sum + count;
  }, 0);

  const totalDailyCompletions = dailies.reduce(
    (sum, d) => sum + (d.counter || 0),
    0,
  );

  // Todos stats
  const today = new Date().toDateString();
  const todosToday = todos.filter(
    (t) => new Date(t.dateCompleted).toDateString() === today,
  ).length;

  const todosThisWeek = todos.filter((t) => {
    const date = new Date(t.dateCompleted);
    return date >= weekAgo;
  }).length;

  const todosAllTime = todos.length;

  console.log({
    completedDailiesToday,
    completedDailiesWeek,
    totalDailyCompletions,
    todosToday,
    todosThisWeek,
    todosAllTime,
  });

  return {
    today: completedDailiesToday + todosToday,
    week: completedDailiesWeek + todosThisWeek,
    allTime: totalDailyCompletions + todosAllTime,
  };
}

let habiticaStats = [];
let jobFailFlag = false;
const README_FILE_PATH = "./README.md";

async function updateReadme(stats) {
  const { today, week, allTime } = stats;

  const todayStats = [`🎯  Completed **${today}** tasks today`];
  habiticaStats.push(todayStats);

  const weekStats = [`📅  Completed **${week}** tasks this week`];
  habiticaStats.push(weekStats);

  const allTimeStats = [
    `⭐  Completed **${Humanize.intComma(allTime)}** tasks all time`,
  ];
  habiticaStats.push(allTimeStats);

  if (habiticaStats.length == 0) return;

  if (habiticaStats.length > 0) {
    const readmeData = fs.readFileSync(README_FILE_PATH, "utf8");

    const newReadme = buildReadme(
      readmeData,
      habiticaStats.join("           \n"),
    );
    if (newReadme !== readmeData) {
      core.info("Writing to " + README_FILE_PATH);
      fs.writeFileSync(README_FILE_PATH, newReadme);
      if (!process.env.TEST_MODE) {
        commitReadme();
      }
    } else {
      core.info("No change detected, skipping");
      process.exit(0);
    }
  } else {
    core.info("Nothing fetched");
    process.exit(jobFailFlag ? 1 : 0);
  }
}

const buildReadme = (prevReadmeContent, newReadmeContent) => {
  const tagToLookFor = "<!-- HABITICA:";
  const closingTag = "-->";
  const startOfOpeningTagIndex = prevReadmeContent.indexOf(
    `${tagToLookFor}START`,
  );
  const endOfOpeningTagIndex = prevReadmeContent.indexOf(
    closingTag,
    startOfOpeningTagIndex,
  );
  const startOfClosingTagIndex = prevReadmeContent.indexOf(
    `${tagToLookFor}END`,
    endOfOpeningTagIndex,
  );
  if (
    startOfOpeningTagIndex === -1 ||
    endOfOpeningTagIndex === -1 ||
    startOfClosingTagIndex === -1
  ) {
    core.error(
      `Cannot find the comment tag on the readme:\n<!-- HABITICA:START -->\n<!-- HABITICA:END -->`,
    );
    process.exit(1);
  }
  return [
    prevReadmeContent.slice(0, endOfOpeningTagIndex + closingTag.length),
    "\n",
    newReadmeContent,
    "\n",
    prevReadmeContent.slice(startOfClosingTagIndex),
  ].join("");
};

const commitReadme = async () => {
  // Getting config
  const committerUsername = "Habitica Bot";
  const committerEmail = "noreply@habitica.com";
  const commitMessage = "chore: update habitica stats in README";
  // const githubToken = process.env.GITHUB_TOKEN;

  if (!GITHUB_TOKEN) {
    core.error("GITHUB_TOKEN environment variable is not set");
    process.exit(1);
  }

  // Doing commit and push
  await exec("git", ["config", "--global", "user.email", committerEmail]);
  await exec("git", ["config", "--global", "user.name", committerUsername]);
  await exec("git", ["config", "--global", "credential.helper", "store"]);

  // Create credentials file for git authentication
  const homeDir = os.homedir();
  const credentialsFile = `${homeDir}/.git-credentials`;
  const credentials = `https://x-access-token:${GITHUB_TOKEN}@github.com\n`;
  fs.writeFileSync(credentialsFile, credentials, { mode: 0o600 });

  await exec("git", ["add", README_FILE_PATH]);
  await exec("git", ["commit", "-m", commitMessage]);
  await exec("git", ["push"]);
  core.info("Readme updated successfully.");

  // Clean up credentials file
  fs.unlinkSync(credentialsFile);

  // Making job fail if one of the source fails
  process.exit(jobFailFlag ? 1 : 0);
};

(async () => {
  await main();
})();
