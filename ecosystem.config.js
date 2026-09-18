module.exports = {
  apps: [
    {
      name: 'zeitnah-admin',
      script: './bin/www',
      instances: 'max',          // Load-balance across all available CPU cores
      exec_mode: 'cluster',      // Enable PM2 cluster mode
      autorestart: true,         // Automatically restart if process crashes
      watch: false,              // Do not watch files in production (saves CPU)
      max_memory_restart: '2.5G', // Headroom for multi-GB video upload stream buffers
      node_args: '--max-old-space-size=2048', // 2 GB V8 heap allocation
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'   // Injected when running: pm2 start ecosystem.config.js --env production
      }
    }
  ]
};
