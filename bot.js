var Discord=require('discord.js');
var auth=require('./auth.json');
var fetch=require('node-fetch');
var request=require('request');
var exec=require('child_process').exec;
var logger=require('js-logging');
var defaultTo=require('object.defaults');
var config={};
var err;
try {
    config=require('./config.json');
} catch (e) {
    err=e;
}
var defaultConfig=require('./default-config.json');

function recursiveDefault(obj, def) {
    defaultTo(obj, def);
    var keys=Object.keys(obj);
    for (var i=0; i<keys.length; ++i) {
        var key=keys[i];
        if (obj[key] instanceof Object && def[key] instanceof Object) {
            recursiveDefault(obj[key], def[key]);
        }
    }
}
recursiveDefault(config, defaultConfig);

// Check if we should set node to permit insecure TLS
if (config.allowInsecure) {
    require('process').env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

if (config.padLog) {
    var longestLengthIn=function(array) {
        var max=-1;
        for (var i=0; i<array.length; ++i) {
            if (array[i].length>max) {
                max=array[i].length;
            }
        }
        return max;
    }

    // Attempt to pad the log format so that all log entries are the same length
    // Assumptions and restrictions documented below
    var logging=config.logging;
    var string=logging.format;
    config.logging.preprocess=function(data) {
        // Pad the level so its centered, surrounded by enough spaces to fit the longest level
        var longestTitle=longestLengthIn(Object.keys(logging.filters));
        if (data.title.length<longestTitle) {
            var diff=longestTitle-data.title.length;
            var leftPad=Math.floor(diff/2);
            var rightPad=diff-leftPad;
            // Account for a misalignment in testing
            // TODO find out why this is needed
            leftPad-=1;
            rightPad-=1;
            data.title=Array(leftPad+2).join(' ')+data.title+Array(rightPad+2).join(' ');
        }
        // Pad the line number so it has spaces to its right until its maximum length
        var lineLength=4; // The number of digits the line field is allocated. Currently maxes at 9999 lines
        if (data.line.length<lineLength) {
            data.line+=Array((lineLength-data.line.length)+2).join(' ');
        }
    };
}

var log=logger.colorConsole(config.logging); // Use default colors. Change if necessary

// Log config override issues if they were found
if (err) log.warning("Could not load config.json: "+err);

var bot=new Discord.Client({
    token: auth.token,
    autorun: true
});

var isPlaying={};

var reconnectAllowedAt={};
var reconnectTimeout=30; // Seconds

var lastSearchedSongs={};

// This is the single audio stream which will be used for all CadenceBot listeners.
// This saves bandwidth and encoding overhead as compared to having one stream for each server.
// As an added bonus, it also keeps all CadenceBot listeners in perfect sync!
// (Seeing as Cadence streams tend to desync over time, this is useful).
const stream = bot.createVoiceBroadcast();

// This function initializes the stream.
// It is provided to allow the stream to reinitialize itself when it encounters an issue...
// Which appears to happen rather often with the broadcast.
function beginGlobalPlayback() {
    stream.playArbitraryInput(config.API.stream.prefix+config.API.stream.stream, {
        'bitrate': config.stream.bitrate,
        'volume': config.stream.volume,
        'passes': config.stream.retryCount
    });
}

// Start up the stream before we initialize event handlers.
// This means that playback can begin as soon as the bot can handle a command.
beginGlobalPlayback();

// Add event handlers for the stream.
// When the stream ends, reconnect and resume it.
// (We don't ever want CadenceBot to lose audio)
stream.on('end', function() {
    beginGlobalPlayback();
    log.info("Global broadcast stream ended, restarting.");
});

// Log errors.
stream.on('error', function(err) {
    log.error("Global broadcast stream error: "+err);
    // End should be triggered as well if this interrupts playback...
    // If this doesn't happen, add a call to beginGlobalPlayback here.
});

// Log warnings.
stream.on('warn', function(warn) {
    log.warning("Global broadcast stream warning: "+warn);
});

// Defined later: Filters that one-step-request attempts to use to choose a song to request
// Filters are queried one at a time, in order of appearance (by iterating over the keys)
// They are stored as an associative array "name": filter, where the name will be used for logging
// Each filter is a function, accepting an array of songs (the lastSearchedSongs entry for the current channel during one-step-request), plus the request string,
//  and returning an integer (the number to pass to a mock request - one plus the index of the target song)
// If the filter cannot choose a single song to request, it may return the subset of results which pass the filter
//  The implementation should replace the array being searched with this subset
// These filters should, however, come as late as reasonable, so as to not filter out results another filter would select unless these are incorrect
// If the filter cannot choose a single song to request, but would not like to narrow the search space, it should return a falsy value (0).
// If the implementation passes all filters without selecting a result,
// It will present the remaining options to the user as if it was `search`, and have them choose a request normally (manual selection filter)
var oneStepRequestFilters;

function songFormat(song) {
    return "\""+(song.title || song.Title)+"\" by "+(song.artist || song.Artist);
}

function searchResultsFormat(songs) {
    var response="";
    for (var i=0; i<songs.length; ++i) {
        response+="  "+(i+1)+")  "+songFormat(songs[i])+"\n";
    }
    return response;
}

function nowPlayingFormat(text) {
    text=text.substring("parseMusic(".length, text.length-2);
    var json=JSON.parse(text);
    var artist=json['/cadence1']['artist_name'].trim();
    var song=json['/cadence1']['song_title'].trim();
    return "\""+song+"\" by "+artist;
}

function splitOnLastLine(text, length, separator="\n") {
    text=text.substring(0, length);
    index = text.lastIndexOf(separator);

    if (index == -1) return text;

    return text.substring(0, index);
}

function sendLongReply(message, text, length=2000) {
    // Proactive bugfix: Make sure that length isn't above 2000 (which is where Discord caps messages)
    if (length>2000) length=2000;

    // Special handling for the first part of the message, and for if the message isn't actually long.
    response=splitOnLastLine(text, length - message.author.id.toString().length - 5);
    message.reply(response);
    text=text.substring(response.length+1);

    // If the text starts with a whitespace character, discord will strip it. This prevents that.
    if (/\s/.test(text.charAt(0))) {
        text = "_"+text.charAt(0)+"_"+text.substring(1);
    }

    while (text.length>length) {
        response=splitOnLastLine(text, length);
        message.channel.send(response);
        text=text.substring(response.length+1);

        // If the text starts with a whitespace character, discord will strip it. This prevents that.
        if (/\s/.test(text.charAt(0))) {
            text = "_"+text.charAt(0)+"_"+text.substring(1);
        }
    }
    if (text.length>0) message.channel.send(text);
}

function selectOne(array) {
    return array[Math.round(Math.random()*(array.length-1))];
}

function command(message) {
    if (message.content===config.commands.play) {
        log.notice("Received play command.");
        if (isPlaying[message.guild.id]) {
            log.info("Already playing in server "+message.guild.name);
            message.reply("Don't you have enough Cadence already?");
        }
        else {
            var voiceChannel=message.member.voiceChannel;
            if (voiceChannel) {
                log.info("Attempting to join voice channel "+voiceChannel.name+" in server "+message.guild.name);

                var rAA=new Date();
                rAA.setSeconds(rAA.getSeconds()+reconnectTimeout);
                reconnectAllowedAt[voiceChannel.id]=rAA;

                isPlaying[message.guild.id]=true;
                voiceChannel.join().then(connection => {
                    log.notice("Joined. Beginning playback (channel bitrate="+voiceChannel.bitrate+").");
                    const dispatch = connection.playBroadcast(stream);
                    dispatch.on("end", end=> {
                        log.warning("Stream ended. Playback was in server "+message.guild.name+", channel "+voiceChannel.name);
                        if (!isPlaying[message.guild.id]) return;

                        log.warning("Error was: "+end);

                        isPlaying[message.guild.id]=false;
                        if (new Date()<reconnectAllowedAt[voiceChannel.id]) {
                            log.notice("Before reconnect timer for channel "+message.guild.name+":"+voiceChannel.name+". Disconnecting");
                            message.reply("Since I've already tried to reconnect in the last "+reconnectTimeout+" seconds, I won't try again.\n\nRun \""+config.commands.play+"\" if you want me to try again.");
                            voiceChannel.leave();
                            return;
                        }
                        log.debug("Was allowed to reconnect to channel with id "+voiceChannel.id+" before "+reconnectAllowedAt[voiceChannel.id]);

                        message.reply("Hm, I seem to have lost Cadence.\n\nLet me see if I can get it back for you.");

                        // Issue a spurious nowplaying to get it in the log.
                        // Should remove this before sending to prod, probably
                        var msg={};
                        msg.content=config.commands.nowplaying;
                        msg.reply=function (s) {log.debug("Sent message: "+s)};
                        log.notice("Sending false nowplaying command in server "+message.guild.name+"...\n");
                        command(msg);

                        // Now, we want to reissue ourselves a play command
                        //  equivalent to the original one, to begin playback on
                        //  the same channel.
                        // At a glance, that means reissuing the original message.
                        // However, if the user has since disconnected...
                        //  ... We'll generate a spurious error.
                        // The play code wants to connect to the user's channel:
                        // It doesn't know what channel to connect to if the user
                        //  isn't connected.
                        // We, however, do.
                        // So, if there isn't a VC, we need to mock it.
                        // At the same time, the user could be in the wrong VC.
                        // That would make us connect to the incorrect channel.
                        // Basically, we just generally want to mock the VC.
                        // That's why the naïve implementation (command(message))
                        //  isn't the one we use here.
                        msg={};
                        msg.content=message.content;
                        msg.reply=function(r) {message.reply(r)};
                        msg.member={};
                        msg.member.voiceChannel=voiceChannel;
                        msg.guild=message.guild;
                        log.notice("Sending mocked play command in server "+message.guild.name+"...\n");
                        command(msg);
                    });
                }).catch(err => log.critical(err));
            }
            else {
                log.error("User "+message.member.user.tag+" is not in a voice channel in server "+message.guild.name+".");
                message.reply("You need to be in a voice channel for me to play Cadence in it, この馬鹿!");
            }
        }
    }
    else if (message.content===config.commands.stop) {
        log.notice("Received stop command.");
        if (isPlaying[message.guild.id]) {
            var voiceChannel=message.member.voiceChannel;
            log.info("Attempting to disconnect from channel in "+message.guild.name+".");
            if (voiceChannel) {
                isPlaying[message.guild.id]=false;
                voiceChannel.leave();
                log.notice("Disconnected from channel "+voiceChannel.name+".");
            }
            else {
                log.notice("User not in a voice channel.");
                message.reply("I dunno, I'd prefer if someone in the channel told me to stop.");
            }
        }
        else {
            log.error("Not currently playing.");
            message.reply("OK, OK, I get it, you don't like me, sheesh!");
        }
    }
    else if (message.content===config.commands.help) {
        log.notice("Received help command.");
        var help="";
        help="I have "+Object.keys(config.commands).length+" commands. They are:\n";
        for (var key in config.commands) {
            if (config.commands.hasOwnProperty(key)) {
                help+="    \""+config.commands[key]+"\" - "+config.commandDescriptions[key]+"\n";
            }
        }
        message.reply(help);
        log.notice("Issued help message.");
    }
    else if (message.content===config.commands.nowplaying) {
        log.notice("Received nowplaying command.");
        const url=config.API.stream.prefix+config.API.stream.nowplaying;
        log.info("Issuing fetch request to "+url);
        fetch(url).then(response => {
            log.info("Received response.");
            response.text().then(text => {
                log.info("Response text:\n\n"+text+"\n\n");
                log.info("Parsing response...");
                song=nowPlayingFormat(text);
                bot.user.setPresence({ game:
                                         { name: song }
                });
                log.notice("Parse complete: Now playing "+song);
                message.reply("Now playing: "+song);
            });
        });
    }
    else if (message.content.startsWith(config.commands.search)) {
        log.notice("Received search command in text channel "+message.channel.name+", server "+message.guild.name+".");
        log.notice("Received message was \""+message.content+"\"");
        const url=config.API.aria.prefix+config.API.aria.search;
        var data={
            search: message.content.substring(config.commands.search.length)
        };

        log.info("Making a request to "+url);
        log.debug("data.search="+data.search);
        var post = {
            url,
            body: data,
            json: true,
            followAllRedirects: true,
            followOriginalHttpMethod: true,
            gzip: true
        };
        request.post(post, function(err, response, songs) {
           log.info("Received response.");
           if (!err && (!response || response.statusCode==200)) {
               log.info("No error, and either no status code or status code 200.");
               log.debug("Received body:\n\n"+JSON.stringify(songs)+"\n\n");
               if (songs==null || songs.length==0) {
                   log.info("No results.");
                   message.reply("Cadence has no results for \""+data.search+"\".");
               }
               else {
                   log.info(songs.length+" result(s).");
                   lastSearchedSongs[message.channel.id]=songs;
                   var response="Cadence returned:\n";
                   response+=searchResultsFormat(songs);
                   log.debug("Issuing response:\n\n"+response+"\n\n");
                   sendLongReply(message, response);
               }
           }
           else {
               log.error("Response is erroneous. Returned body:\n\n"+body+"\n\n");
               if (response) {
                   log.error("Returned status code: "+response.statusCode);
                   message.reply("Error "+response.statusCode+". Aria says:\n\n"+body);
               }
               else {
                   log.error("No status code.");
                   message.reply("Error. Aria says:\n\n"+body);
               }
           }
        });
    }
    else if (message.content.startsWith(config.commands.request)) {
        log.notice("Received song request in text channel "+message.channel.name+", server "+message.guild.name+".");
        log.notice("Received message was \""+message.content+"\"");
        log.debug("Last searched songs:\n\n"+JSON.stringify(lastSearchedSongs[message.channel.id])+"\n\n");
        lastSearchedSongs[message.channel.id]=lastSearchedSongs[message.channel.id] || []; // Default to empty array to avoid crash

        const url=config.API.aria.prefix+config.API.aria.request;
        var song=parseInt(message.content.substring(config.commands.request.length))-1;
        if (isNaN(song)) {
            // Try to conduct a search, to see if we can perform a one-step request
            song=message.content.substring(config.commands.request.length);
            log.warning(song+" is not a number. Attempting one-step request.");

            // First, perform a mocked search, backing up lastSearchedSongs and saving the result string
            var response=false;
            var msg={};
            msg.channel=message.channel;
            msg.guild=message.guild;
            msg.client=message.client;
            msg.author={tag: message.author.tag, id: message.author.id};
            msg.reply=function(r) {
                log.notice("Mocked search returned:\n\n");
                log.notice(r+"\n\n");
                // Make response false if we have no results, to avoid bugs later
                response=!r.includes("no results");
            };
            msg.content=config.commands.search+song;
            lSS=lastSearchedSongs[message.channel.id].slice();

            log.notice("Issuing mocked search command in server "+message.guild.name+"...\n");
            command(msg);

            // Delay one second to allow search to complete
            setTimeout(function() {
                // Now, if any filter can select one song out of lastSearchedSongs, request it.
                var request=0;
                var keys=Object.keys(oneStepRequestFilters);
                var key;
                for (var i=0; i<keys.length; ++i) {
                    request=oneStepRequestFilters[keys[i]](lastSearchedSongs[message.channel.id], song);
                    if (request) {
                        if (Array.isArray(request)) {
                            if (request.length>0) { // Prevent narrowing to empty results
                                log.notice(keys[i]+" elected to narrow from "+lastSearchedSongs[message.channel.id].length+" to "+request.length);
                                log.debug("Previous values:\n\n"+JSON.stringify(lastSearchedSongs[message.channel.id])+"\n\n");

                                lastSearchedSongs[message.channel.id]=request;

                                log.debug("Narrowed values:\n\n"+JSON.stringify(request)+"\n\n");
                                request=0;
                            }
                        }
                        else {
                            key=keys[i];
                            log.notice(key+" chose song "+request);
                            break;
                        }
                    }
                }
                if (request>0) {
                    // Generate a mocked request call, now requesting the filter's result
                    var msg={};
                    msg.channel=message.channel;
                    msg.guild=message.guild;
                    msg.author={tag: message.author.tag, id: message.author.id};
                    msg.reply=function(r) {
                        // Custom message for successful requests
                        if (r.includes("received") && !r.includes("Aria says")) {
                            var song=lastSearchedSongs[message.channel.id][request-1];
                            message.reply("Requested "+songFormat(song)+".");
                        }
                        else {
                            message.reply(r);
                        }
                    };
                    msg.content=config.commands.request+request;

                    log.notice("Issuing mocked request command in server "+message.guild.name+"...\n");
                    command(msg);

                    // Now that the song has been requested, log our success in one-step request
                    log.notice("Successfully performed one-step request for: "+song+" using the \""+key+"\" filter.");

                    // And restore lastSearchedSongs after a short delay (for the request to actually succeed)
                    setTimeout(function() {
                        log.info("Restoring lastSearchedSongs...");
                        lastSearchedSongs[message.channel.id]=lSS;
                        log.debug("lastSearchedSongs restored to:\n\n"+JSON.stringify(lastSearchedSongs[message.channel.id])+"\n\n")
                    }, config.roundtripDelayMs);
                }
                // For the moment, we don't know how to perform one-step request for this set of responses
                else {
                    log.error("Could not perform one-step request for "+song);
                    if (lastSearchedSongs[message.channel.id].length==0 || !response) {
                        // For no results, assume the user meant to perform a normal (two-step) request
                        log.info("Zero length results (assuming inadvertent request");

                        // Message recommended by Ken Ellorando
                        message.channel.send("Sorry, <@"+message.author.id+">, I couldn't find any matching songs to fit your request \'"+song+"\'.");

                        // Since lastSearchedSongs is now empty, restore it.
                        lastSearchedSongs[message.channel.id]=lSS;
                    }
                    else {
                        string="I'm sorry, I couldn't discriminate between "+lastSearchedSongs[message.channel.id].length+" songs.\n\n"+
                                      "Please run \""+config.commands.request+"\" with the number of the song you'd like to request.\n\n"+searchResultsFormat(lastSearchedSongs[message.channel.id]);
                        log.debug("Issuing response:\n\n"+string+"\n\n");
                        sendLongReply(message, string);
                        // Since we instruct the user to use lastSearchedSongs, we overwrite the old copy.
                    }
                }
            }, config.roundtripDelayMs);
            return;
        }
        if (lastSearchedSongs[message.channel.id].length==0) {
            log.error("No stored results.");
            message.reply("Please search for your songs before requesting them.");
            return;
        }
        if (song<0) {
            log.error("Non-positive input.");
            message.reply("Sorry, I cannot request a song with a non-positive number.");
            return;
        }
        log.notice("Prepared to construct request for song at index "+song);
        if (song>=lastSearchedSongs[message.channel.id].length) {
            log.error("Index out-of-bounds.");
            message.reply("Sorry, I can't request song number "+(song+1)+" out of a set of "+lastSearchedSongs[message.channel.id].length+".");
            return;
        }


        var data={
            ID: lastSearchedSongs[message.channel.id][song].ID.toString()
        };

        // If support is enabled, set the tag to the user's Discord tag
        if (config.enableRequestTags) {
            if (config.useGuildTagsForRequests)
                data.tag=message.guild.id
            else
                data.tag=message.author.tag
        }

        var post={
            url,
            body: JSON.stringify(data),
            followAllRedirects: true,
            followOriginalHttpMethod: true,
            gzip: true
        };

        log.info("Making a request to "+url);
        log.debug("body="+post.body);
        request.post(post, function(err, response, body) {
            log.info("Received response.");
            if (!err && (!response || response.statusCode==200 || response.statusCode==202)) {
                log.notice("Request received. Clearing lastSearchedSongs...");
                log.info("Aria says: "+body);
                message.reply("Your request has been received.");
                lastSearchedSongs[message.channel.id]=[];
            }
            else if (response) {
                if (response.statusCode==429) {
                    log.warning("Request failed with status code "+response.statusCode);
                    log.notice("Issued rate limiting message.");
                    message.reply("Sorry, Cadence limits you to one request every five minutes.");
                }
                else {
                    log.error("Request failed with status code "+response.statusCode);
                    log.error("Aria says: "+body);
                    message.reply("Error "+response.statusCode+". Aria says:\n\n"+body);
                }
            }
            else {
                log.error("Request failed without status code.");
                log.error("Aria says: "+body);
                message.reply("Error. Aria says:\n\n"+body);
            }
        });
    }
    else if (message.content===config.commands.library) {
        log.notice("Received library listing command in text channel "+message.channel.name+", server "+message.guild.name+".");
        log.notice("Received message was \""+message.content+"\"");
        const url=config.API.aria.prefix+config.API.aria.library;

        log.info("Making a request to "+url);
        request.get({url, form: {}}, function(err, response, body) {
           log.info("Received response.");
           if (!err && (!response || response.statusCode==200)) {
               log.info("No error, and either no status code or status code 200.");
               log.debug("Received body:\n\n"+body+"\n\n");
               var songs=JSON.parse(body);
               if (songs.length==0) {
                   log.warning("Empty library results.");
                   message.reply("Cadence returned no library contents.");
               }
               else {
                   log.info(songs.length+" result(s).");

                   var response="The Cadence library contains:\n";
                   response+=searchResultsFormat(songs);
                   log.debug("Issuing response:\n\n"+response+"\n\n");
                   sendLongReply(message, response);

                   // ARIA's library API only sends {artist, title} pairs.
                   // CadenceBot offers request-from-library...
                   // Which means we need to add IDs into the data before it goes into lastSearchedSongs.
                   // Luckily, we know that Cadence orders the library in ascending order of ID
                   // (as a consequence of how both are populated)
                   // and that ID starts at 1.
                   for (var i=0; i<songs.length; ++i) {
                       // Don't overwrite the existing ID if it exists
                       // (this protects against API changes in the future)
                       if (songs[i].ID == undefined) songs[i].ID=i+1;
                   }

                   lastSearchedSongs[message.channel.id]=songs;
               }
           }
           else {
               log.error("Response is erroneous. Returned body:\n\n"+body+"\n\n");
               if (response) {
                   log.error("Returned status code: "+response.statusCode);
                   message.reply("Error "+response.statusCode+". Aria says:\n\n"+body);
               }
               else {
                   log.error("No status code.");
                   message.reply("Error. Aria says:\n\n"+body);
               }
           }
        });
    }
    else if (config.enableLogMailing && message.content==config.logMailCommand) {
        log.debug("Ordered to mail a log file");
        exec('./maillog.sh', {'shell': '/bin/bash', 'cwd': '.'});
        log.debug("Script executed.");
    }
    // If none of those, check custom commands
    else {
        log.debug("Checking custom commands.");
        // equalTo check is easy
        if (config.customCommands.equalTo.hasOwnProperty(message.content)) {
            if (!config.customCommands.equalTo[message.content].disabled) {
                log.info("Command "+message.content+" matched an equalTo custom command.")
                var operation=config.customCommands.equalTo[message.content];
                // Either random or response must exist: Prefer random if both exist
                if (operation.random) {
                    message.channel.send(selectOne(operation.random));
                }
                else {
                    message.channel.send(operation.response);
                }
            }
        }
        else {
            // startsWith and targeted are harder.
            // First, the escaping function.
            var format = function(str, chr, replace) {
                // Escape chr so no regex funny business can happen
                chr = chr.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
                var re = new RegExp("[^%]?%"+chr, "g");
                return str.replace(re, ' '+replace).replace("%%"+chr, "%"+chr)
            };

            // Now, process targeted custom sequences
            for (var i in Object.keys(config.customCommands.targeted)) {
                var key = Object.keys(config.customCommands.targeted)[i];

                if (message.content.startsWith(key) && !config.customCommands.targeted[key].disabled) {
                    log.info("Command "+message.content+" matched targeted custom command "+key);

                    var operation=config.customCommands.targeted[key];
                    var output;
                    // Either random or format must be present. Prefer random if both exist.
                    if (operation.random) {
                        output=(operation.random);
                    }
                    else {
                        output=operation.format;
                    }

                    // Make sure we have a mention if we need one
                    if (operation.replyOnly) {
                        if (operation.continues) {
                            // We need to format in some content
                            var content=message.content.substring(key.length);
                            // Format content string into the message
                            content=format(output, 's', content);
                            // Collapse spaces and send
                            content=content.replace(new RegExp("  +", "g"), " ")
                            message.reply(content);
                        }
                        else {
                            // Just return the format string
                            message.reply(output);
                        }
                        return;
                    }
                    else if (message.mentions.users.size==0) {
                        log.debug("Zero mentions.")
                        message.reply("I'm sorry, I don't know who you want me to direct that to - Could you ask me again and mention them?");
                        return
                    }
                    else {
                        var target=message.mentions.users.first();
                        log.debug("Sent reply to "+target.tag)

                        // Reply with user mention
                        var mentioned=format(output, 'u', target.toString());

                        // If the format wants content added, strip mentions and add the content.
                        // Strip multiple spaces so that tag artifacts aren't left behind
                        // This might look weird if the mention is in the middle. Don't use patterns that encourage that.
                        if (output.continues) {
                            // Strip mentions
                            var content=message.content.substring(key.length);
                            var mentions=new RegExp("\\\\?<([^>]+)>", "g")
                            content=content.replace(mentions, '');

                            // Now format that content string into the message.
                            content=format(mentioned, 's', content);
                            // Now collapse multiple spaces and send
                            content=content.replace(new RegExp("  +", "g"), " ")
                            message.channel.send(content);
                        }
                        else {
                            // Just send the mentioned reply
                            message.channel.send(mentioned)
                        }
                        return;
                    }
                }
            }

            // Now, multitargeteds
            for (var i in Object.keys(config.customCommands.multitargeted)) {
                var key = Object.keys(config.customCommands.multitargeted)[i];

                if (message.content.startsWith(key) && !config.customCommands.multitargeted[key].disabled) {
                    log.info("Command "+message.content+" matched multitargeted custom command "+key);
                    var operation=config.customCommands.multitargeted[key];
                    if (operation.totalCount<=0) {
                        log.warning("Could not perform mentioning: count "+operation.totalCount+"<=0. Skipping.");
                        continue;
                    }

                    // Parse out the mentions.
                    var phrase=message.content.substring(key.length);
                    var remaining=operation.totalCount;
                    var remainingFormat=operation.parseFormat;
                    var mentions={};
                    do {
                        var index=remainingFormat.indexOf("%u");
                        if (index==-1 || index+2>=remainingFormat.length) {
                            log.error("parseFormat "+operation.parseFormat+" is malformed: "+remaining+" mentions should remain.");
                            continue;
                        }
                        if (index>=phrase.length) {
                            log.warning("Message is malformed. Remaining user input: "+phrase+", remaining format string: "+remainingFormat);
                            continue;
                        }
                        var idx=parseInt(remainingFormat[index+2]);
                        phrase=phrase.substring(index);
                        remainingFormat=remainingFormat.substring(index+2+idx.toString().length);
                        index=phrase.indexOf(" ");
                        if (index==-1) {
                            mentions[idx]=phrase;
                            break;
                        }
                        else {
                            mentions[idx]=phrase.substring(0, index);
                        }
                        phrase=phrase.substring(index);
                        --remaining;
                    } while(remaining>0);

                    // Now, format mentions into the output string
                    // Either random or format must exist. If both exist, prefer random.
                    if (operation.random) {
                        phrase=selectOne(operation.random);
                    }
                    else {
                        phrase=operation.format;
                    }
                    for (var i in mentions) {
                        phrase=format(phrase, "u"+i, mentions[i]);
                    }

                    // And send out the message.
                    message.channel.send(phrase);
                    return;
                }
            }

            // Finally, the startsWith set
            for (var i in Object.keys(config.customCommands.startsWith)) {
                var key = Object.keys(config.customCommands.startsWith)[i];

                if (message.content.startsWith(key) && !config.customCommands.startsWith[key].disabled) {
                    log.info("Command "+message.content+" matched startsWith custom command "+key);
                    var operation=config.customCommands.startsWith[key];
                    var output;
                    // Either random or format must be set. Prefer random if both are present
                    if (operation.random) {
                        output=selectOne(operation.random);
                    }
                    else {
                        output=operation.format;
                    }
                    message.channel.send(format(output, 's', message.content.substring(key.length)));
                    return;
                }
            }
            log.debug("Not a custom command.")
        }
    }
}

bot.on('message', message => {
    command(message)
});

bot.on('guildCreate', guild => {
    isPlaying[guild.id]=false;
});

function updatePresence() {
    log.debug("Setting status message...");

    // Allow disable of presence feature
    // (also preventing crashes from bad interval settings
    if (config.statusUpdateIntervalMs<0) {
        log.info("Status update interval set to "+config.statusUpdateIntervalMs+". Setting disabled-update message.");
        bot.user.setPresence({ game:
                                 { name: "Cadence Radio" }
        });
        return;
    }

    log.debug("Fetching nowplaying information...");
    fetch(config.API.stream.prefix+config.API.stream.nowplaying).then(response => {
        response.text().then(text => {
            log.debug("Received response:\n\n"+text+"\n\n");
            song=nowPlayingFormat(text);
            log.debug("Now playing:\n\n"+song+"\n\n");
            bot.user.setPresence({ game:
                                     { name: song }
            });
            bot.setTimeout(updatePresence, config.statusUpdateIntervalMs);
            log.debug("Set timeout to be called again");
        });
    });
}

bot.on('ready', updatePresence);

// Returns whether the two string parameters are the same-ish
function caselessCompare (a, b) {
    a=''+a;
    b=''+b;
    return !a.localeCompare(b, "en-US", {
        "usage": "search",
        "sensitivity": "base",
        "ignorePunctuation": "true"
    });
}

oneStepRequestFilters={
    "trivial-filter": function(songs) {
        if (songs.length==1)
            return 1;
        else
            return 0;
    },
    "title-filter": function(songs, request) {
        var result=0;
        for (var i=0; i<songs.length; ++i) {
            if (caselessCompare(songs[i].title, request)) {
                if (result) { // Non-unique result
                    return 0;
                }
                result=i+1;
            }
        }
        return result;
    },
    "artist-filter": function(songs, request) {
        var result=0;
        for (var i=0; i<songs.length; ++i) {
            if (caselessCompare(songs[i].artist, request)) {
                if (result) { // Non-unique result
                    return 0;
                }
                result=i+1;
            }
        }
        return result;
    },
    "title+artist-filter": function(songs, request) {
        var result=0;
        var condition=function(req, title, artist) {
            req=''+req;
            req=req.replace(/[&\/\\#,+\(\)$~%\.!^'"\;:*?\[\]<>{}]/g, '');
            title=''+title;
            title=title.replace(/[&\/\\#,+\(\)$~%\.!^'"\;:*?\[\]<>{}]/g, '');
            artist=''+artist;
            artist=artist.replace(/[&\/\\#,+\(\)$~%\.!^'"\;:*?\[\]<>{}]/g, '');
            return caselessCompare(req.substring(0, title.length), title)
                && caselessCompare(req.substring(req.length-artist.length), artist);
        };
        for (var i=0; i<songs.length; ++i) {
            if (condition(request, songs[i].title, songs[i].artist)) {
                if (result) { // Non-unique result
                    return 0;
                }
                result=i+1;
            }
        }
        return result;
    },
    "artist+title-filter": function(songs, request) {
        var result=0;
        var condition=function(req, title, artist) {
            req=''+req;
            req=req.replace(/[&\/\\#,+\(\)$~%\.!^'"\;:*?\[\]<>{}]/g, '');
            title=''+title;
            title=title.replace(/[&\/\\#,+\(\)$~%\.!^'"\;:*?\[\]<>{}]/g, '');
            artist=''+artist;
            artist=artist.replace(/[&\/\\#,+\(\)$~%\.!^'"\;:*?\[\]<>{}]/g, '');
            return caselessCompare(req.substring(0, artist.length), artist)
                && caselessCompare(req.substring(req.length-title.length), title);
        };
        for (var i=0; i<songs.length; ++i) {
            if (condition(request, songs[i].title, songs[i].artist)) {
                if (result) { // Non-unique result
                    return 0;
                }
                result=i+1;
            }
        }
        return result;
    },
    "artists-narrowing-filter": function(songs, request) {
        var output=[];
        for (var i=0; i<songs.length; ++i) {
            if (caselessCompare(songs[i].artist, request)) {
                output.push(songs[i]);
            }
        }
        if (output.length==0) {
            return 0;
        }
        return output;
    }
}

log.alert("Starting bot");

bot.login(auth.token);
