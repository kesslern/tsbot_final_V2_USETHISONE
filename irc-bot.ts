import irc from 'irc';

const config = {
    server: 'irc.libera.chat',
    port: 6667,
    nick: 'TypeScriptBot',
    channels: ['#examplechannel'], // Change to your desired channel
};

const bot = new irc.Client(config.server, config.nick, {
    channels: config.channels,
    port: config.port,
    autoConnect: true,
});

bot.addListener('registered', () => {
    console.log(`Connected to ${config.server}`);
});

bot.addListener('join', (channel, nick) => {
    if (nick === config.nick) {
        bot.say(channel, 'hello');
    }
});

bot.addListener('message', (from, to, message) => {
    if (message.toLowerCase().includes(config.nick.toLowerCase())) {
        bot.say(to, 'hello');
    }
});

bot.addListener('error', (message) => {
    console.error('IRC Error:', message);
});
