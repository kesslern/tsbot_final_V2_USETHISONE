import type { Plugin } from '../plugin-manager.js';

const responder: Plugin = {
    name: 'responder',
    onJoin: (channel, nick, bot) => {
        if (nick === bot.nick) {
            bot.say(channel, 'hello');
        }
    },
    onMessage: (from, to, message, bot) => {
        if (message.toLowerCase().includes(bot.nick.toLowerCase())) {
            bot.say(to, 'hello');
        }
    },
};

export default responder;
