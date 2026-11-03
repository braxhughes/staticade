// the Daily ticket window, in one place for the server (server/daily.js) and the game's send queue
// (games/starfall/submit-queue.js). The site deploy copies leaderboard/ but not server/daily.js, so the numbers live here.
// A Daily must arrive within its play time (frames / FPS) + TICKET_GRACE_S + TICKET_SLACK_S after its ticket was issued.
export const TICKET_SLACK_S = 10; // allowance for two Worker copies' clocks (see server/daily.js)
export const TICKET_GRACE_S = 600; // the time around a run that is not play time: pause, name entry, send and retries
export const FPS = 60;
