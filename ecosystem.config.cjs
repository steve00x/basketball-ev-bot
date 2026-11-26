// PM2: keeps the bots running on a PC or server, restarts them after a crash, starts them at boot.
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs --only deriv     # Deriv only (or leave out --only for both)
//   pm2 save && pm2 startup                         # start again after a reboot (run the command it prints)
//   pm2 logs / pm2 status / pm2 stop all
const common = {
  cwd: __dirname,
  autorestart: true,
  exp_backoff_restart_delay: 2000, // 2 s, 4 s, 8 s ... up to 15 min while it keeps failing
  max_memory_restart: '700M',
  merge_logs: true,
  time: true, // dates in the log files
};

module.exports = {
  apps: [
    { ...common, name: 'deriv', script: 'bin/deriv-bot.js', args: 'run', kill_timeout: 45000, out_file: 'logs/deriv.log', error_file: 'logs/deriv.log' }, // lets an open contract finish
    { ...common, name: 'betika', script: 'bin/ev-bot.js', args: 'scan', kill_timeout: 120000, out_file: 'logs/betika.log', error_file: 'logs/betika.log' }, // finishes the scan cycle
  ],
};
