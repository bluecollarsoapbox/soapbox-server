// index.js — run API and Discord bot in one Render service
require('dotenv').config();
require('./server'); // starts Express and exposes routes
require('./bot');    // logs in to Discord
