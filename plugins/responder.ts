import type { Plugin } from '../plugin-manager.ts';

const responder: Plugin = {
  name: 'responder',
  onJoin: ({ channel, nick, bot }) => {
    if (nick === bot.nick) {
      bot.say(channel, 'hello');
    }
  },
  onMessage: ({ to, bot }) => {
    bot.say(to, 'hello');
  },
};

export default responder;
