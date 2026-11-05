// In-process event bus between the API (Roblox side) and the bot (Discord
// side), so the two stay separate modules. Events:
//   statsChanged (player)  - a player's saved totals changed
const { EventEmitter } = require('node:events');

module.exports = new EventEmitter();
