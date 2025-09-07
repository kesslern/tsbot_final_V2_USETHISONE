import irc from 'irc';

const responder = {
    name: 'responder',
    onJoin: (channel: string, nick: string, bot: irc.Client) => {
        if (nick === bot.nick) {
            bot.say(channel, 'hello');
        }
    },
    onMessage: (from: string, to: string, message: string, bot: irc.Client) => {
        if (message.toLowerCase().includes(bot.nick.toLowerCase())) {
            bot.say(to, 'hello');
        }
    },
};

export default responder;
