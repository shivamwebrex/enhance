// ecosystem.config.js
module.exports = {
    apps: [
      {
        name: 'enhancer-watch',
        script: './index.js',
        args: '--watch',
        watch: false,          // PM2's own watch — keep OFF, you have chokidar
        autorestart: true,     // restart if it crashes
        max_restarts: 5,       // don't infinite loop on repeated crashes
        restart_delay: 3000,   // wait 3s before restarting
        log_file: '~/.enhance/watcher.log',
        error_file: '~/.enhance/error.log',
        time: true             // adds timestamps to logs
      }
    ]
  };