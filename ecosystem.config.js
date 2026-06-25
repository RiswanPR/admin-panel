module.exports = {
  apps: [
    {
      name: 'zeitnah-admin',
      script: './bin/www',
      instances: 'max',          // Load-balance across all available CPU cores
      exec_mode: 'cluster',      // Enable PM2 cluster mode
      autorestart: true,         // Automatically restart if process crashes
      watch: false,              // Do not watch files in production (saves CPU)
      max_memory_restart: '1G',  // Restart process if memory exceeds 1GB (mitigates memory leaks)
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'   // Injected when running: pm2 start ecosystem.config.js --env production
      }
    }
  ]
};
