"use strict";
// - TEST: Does it cycle from 98,99,00,01?
// - TEST: Does it fail gracefully (on the invite) if all conf exts are used?

var Promise = require("bluebird");
var uuid = require("uuid");

var AppServiceRegistration = require("matrix-appservice").AppServiceRegistration;
var Cli = require("matrix-appservice-bridge").Cli;
var Bridge = require("matrix-appservice-bridge").Bridge;
var MatrixRoom = require("matrix-appservice-bridge").MatrixRoom;
var MatrixUser = require("matrix-appservice-bridge").MatrixUser;

var VertoEndpoint = require("./lib/endpoint");
var CallStore = require("./lib/call-store");
var ConferenceCall = require("./lib/conf-call");

var REGISTRATION_FILE = "config/verto-registration.yaml";
var CONFIG_SCHEMA_FILE = "config/verto-config-schema.yaml";
var ROOM_STORE_FILE = "config/room-store.db";
var USER_STORE_FILE = "config/user-store.db";
var USER_PREFIX = "fs_";
var EXTENSION_PREFIX = "35"; // the 'destination_number' to dial: 35xx
var CANDIDATE_TIMEOUT_MS = 1000 * 3; // 3s

var verto, bridgeInst;
var calls = new CallStore(EXTENSION_PREFIX);

function runBridge(port, config) {
    // Create a verto instance and login, then listen on the bridge.
    verto = new VertoEndpoint(config.verto.url, config["verto-dialog-params"],
    function(msg) { // handle the incoming verto request
        switch (msg.method) {
            case "verto.answer":
                if (!msg.params || !msg.params.sdp || msg.params.callID === undefined) {
                    console.error("Missing SDP and/or CallID");
                    return;
                }
                var matrixSide = calls.getByVertoCallId(msg.params.callID).matrixSide;
                if (!matrixSide) {
                    console.error("No call with ID '%s' exists.", msg.params.callID);
                    return;
                }

                // find out which user should be sending the answer
                bridgeInst.getRoomStore().getMatrixRoom(matrixSide.roomId).then(
                function(room) {
                    if (!room) {
                        throw new Error("Unknown room ID: " + matrixSide.roomId);
                    }
                    var sender = room.get("fs_user");
                    if (!sender) {
                        throw new Error("Room " + matrixSide.roomId + " has no fs_user");
                    }
                    var intent = bridgeInst.getIntent(sender);
                    return intent.sendEvent(matrixSide.roomId, "m.call.answer", {
                        call_id: matrixSide.mxCallId,
                        version: 0,
                        answer: {
                            sdp: msg.params.sdp,
                            type: "answer"
                        }
                    });
                }).then(function() {
                    return verto.sendResponse({
                        method: msg.method
                    }, msg.id);
                }).done(function() {
                    console.log("Forwarded answer.");
                }, function(err) {
                    console.error("Failed to send m.call.answer: %s", err);
                    console.log(err.stack);
                    // TODO send verto error response?
                });
                break;
            case "verto.bye":
                if (!msg.params || !msg.params.callID) {
                    return;
                }
                var callInfo = calls.getByVertoCallId(msg.params.callID);
                if (!callInfo.matrixSide) {
                    console.error("No call with ID '%s' exists.", msg.params.callID);
                    return;
                }
                var intent = bridgeInst.getIntent(callInfo.vertoCall.fsUserId);
                intent.sendEvent(callInfo.matrixSide.roomId, "m.call.hangup", {
                    call_id: callInfo.matrixSide.mxCallId,
                    version: 0
                });
                calls.delete(callInfo.vertoCall, callInfo.matrixSide);
                break;
            default:
                console.log("Unhandled method: %s", msg.method);
                break;
        }
    });

    bridgeInst = new Bridge({
        homeserverUrl: config.homeserver.url,
        domain: config.homeserver.domain,
        registration: REGISTRATION_FILE,
        roomStore: ROOM_STORE_FILE,
        userStore: USER_STORE_FILE,
        queue: {
            type: "per_room",
            perRequest: true
        },

        controller: {
            onUserQuery: function(queriedUser) {
                // auto-create "users" when queried iff they can be base 64
                // decoded to a valid room ID
                var roomId = getTargetRoomId(queriedUser.getId());
                if (!isValidRoomId(roomId)) {
                    console.log("Queried with invalid user ID (decoded to %s)", roomId);
                    return null;
                }
                return {
                    name: "VoIP Conference"
                };
            },

            onEvent: function(request, context) {
                var promise = handleEvent(request, context);
                if (!promise) {
                    promise = Promise.resolve("unhandled event");
                }
                else {
                    console.log("[%s] Handling request", request.getId());
                }
                request.outcomeFrom(promise);
            }
        }
    });

    verto.login(
        config["verto-dialog-params"].login,
        config.verto.passwd
    ).done(function() {
        bridgeInst.run(port, config);
        console.log("Running bridge on port %s", port);
        bridgeInst.getRequestFactory().addDefaultTimeoutCallback(function(req) {
            console.error("DELAYED: %s", req.getId());
        }, 5000);
    }, function(err) {
        console.error("Failed to login to verto: %s", JSON.stringify(err));
        process.exit(1);
    });
}

function getExtensionToCall(fsUserId) {
    var vertoCall = calls.fsUserToConf[fsUserId];
    if (vertoCall) {
        return vertoCall.ext; // we have a call for this fs user already
    }
    var ext = calls.nextExtension();
    if (calls.extToConf[ext]) {
        console.log("Extension %s is in use, finding another..", ext);
        // try to find an unoccupied extension... this will throw if we're out
        ext = calls.anyFreeExtension();
    }
    return ext;
}

function handleEvent(request, context) {
    var event = request.getData();
    var fsUserId = context.rooms.matrix.get("fs_user");
    var vertoCall, matrixSide, targetRoomId, promise;
    if (fsUserId) {
        vertoCall = calls.fsUserToConf[fsUserId];
        if (vertoCall) {
            matrixSide = vertoCall.getByUserId(event.user_id);
        }
        targetRoomId = getTargetRoomId(fsUserId);
    }
    // auto-accept invites directed to @fs_ users
    if (event.type === "m.room.member") {
        console.log(
            "Member update: room=%s member=%s -> %s",
            event.room_id, event.state_key, event.content.membership
        );
        if (event.content.membership === "invite" &&
                context.targets.matrix.localpart.indexOf(USER_PREFIX) === 0) {
            targetRoomId = getTargetRoomId(context.targets.matrix.getId());
            if (!isValidRoomId(targetRoomId)) {
                console.log(
                    "Bad fs_user_id: %s decoded to room %s",
                    context.targets.matrix.getId(), targetRoomId
                );
                return Promise.reject("Malformed user ID invited");
            }
            var intent = bridgeInst.getIntent(context.targets.matrix.getId());
            return intent.join(targetRoomId).then(function() {
                return intent.join(event.room_id);
            }).then(function() {
                // pair this user with this room ID
                var room = new MatrixRoom(event.room_id);
                room.set("fs_user", context.targets.matrix.getId());
                room.set("inviter", event.user_id);
                return bridgeInst.getRoomStore().setMatrixRoom(room);
            });
        }
        else if (event.content.membership === "leave" ||
                event.content.membership === "ban") {
            if (!vertoCall) {
                return Promise.resolve("User not in a call");
            }
            if (context.targets.matrix.getId() === fsUserId &&
                    targetRoomId === event.room_id) {
                // cheeky users have kicked the conf user from the
                // target room - boot everyone off the conference
                console.log(
                    "Conference user is no longer in the target " +
                    "room. Killing conference."
                );
                vertoCall.getAllMatrixSides().forEach(function(side) {
                    verto.sendBye(vertoCall, side);
                    calls.delete(vertoCall, side);
                });
                return Promise.resolve("Killed conference");
            }
            matrixSide = vertoCall.getByUserId(
                context.targets.matrix.getId()
            );
            // hangup if this user is in a call.
            if (!matrixSide) {
                return Promise.reject("User not in a call - no hangup needed");
            }
            promise = verto.sendBye(vertoCall, matrixSide);
            calls.delete(vertoCall, matrixSide);
            return promise;
        }
    }
    else if (event.type === "m.call.invite") {
        console.log(
            "Call invite: room=%s member=%s content=%s",
            event.room_id, event.user_id, JSON.stringify(event.content)
        );
        // only accept call invites for rooms which we are joined to
        if (!targetRoomId) {
            return Promise.reject("No valid fs room for this invite");
        }
        if (targetRoomId === event.room_id) {
            // someone sent a call invite to the group chat(!) ignore it.
            return Promise.reject("Bad call invite to group chat room");
        }
        // make sure this user is in the target room.
        return bridgeInst.getIntent(fsUserId).roomState(targetRoomId).then(
        function(state) {
            var userInRoom = false;
            for (var i = 0; i < state.length; i++) {
                if (state[i].type === "m.room.member" &&
                        state[i].content.membership === "join" &&
                        state[i].state_key === event.user_id) {
                    userInRoom = true;
                    break;
                }
            }
            if (!userInRoom) {
                throw new Error("User isn't joined to group chat room");
            }

            if (!vertoCall) {
                vertoCall = new ConferenceCall(
                    fsUserId, getExtensionToCall(fsUserId)
                );
            }
            var callData = {
                roomId: event.room_id,
                mxUserId: event.user_id,
                mxCallId: event.content.call_id,
                vertoCallId: uuid.v4(),
                offer: event.content.offer.sdp,
                candidates: [],
                pin: generatePin(),
                timer: null,
                sentInvite: false
            };
            vertoCall.addMatrixSide(callData);
            calls.set(vertoCall);
            return verto.attemptInvite(vertoCall, callData, false);
        });
    }
    else if (event.type === "m.call.candidates") {
        console.log(
            "Call candidates: room=%s member=%s content=%s",
            event.room_id, event.user_id, JSON.stringify(event.content)
        );
        if (!matrixSide) {
            return Promise.reject("Received candidates for unknown call");
        }
        event.content.candidates.forEach(function(cand) {
            matrixSide.candidates.push(cand);
        });
        return verto.attemptInvite(vertoCall, matrixSide, false);
    }
    else if (event.type === "m.call.hangup") {
        console.log(
            "Call hangup: room=%s member=%s content=%s",
            event.room_id, event.user_id, JSON.stringify(event.content)
        );
        if (!matrixSide) {
            return Promise.reject("Received hangup for unknown call");
        }
        promise = verto.sendBye(vertoCall, matrixSide);
        calls.delete(vertoCall, matrixSide);
        return promise;
    }
}

function generatePin() {
    return Math.floor(Math.random() * 10000); // random 4-digits
}

function isValidRoomId(roomId) {
    return /^!.+:.+/.test(roomId);  // starts with !, has stuff, :, has more stuff
}

function getTargetRoomId(fsUserId) {
    // The fs user ID contains the base64d room ID which is
    // the room whose members are trying to place a conference call e.g.
    // !foo:bar => IWZvbzpiYXI=
    // @fs_IWZvbzpiYXI=:localhost => Conf call in room !foo:bar
    var lpart = new MatrixUser(fsUserId).localpart;
    var base64roomId = lpart.replace(USER_PREFIX, "");
    return base64decode(base64roomId);
}

function base64decode(str) {
    try {
        return new Buffer(str, "base64").toString();
    }
    catch(e) {
        // do nothing
    }
    return null;
}

// === Command Line Interface ===
var c = new Cli({
    registrationPath: REGISTRATION_FILE,
    bridgeConfig: {
        schema: CONFIG_SCHEMA_FILE
    },
    generateRegistration: function(appServiceUrl, callback) {
        var reg = new AppServiceRegistration(appServiceUrl);
        reg.setHomeserverToken(AppServiceRegistration.generateToken());
        reg.setAppServiceToken(AppServiceRegistration.generateToken());
        reg.setSenderLocalpart("vertobot");
        reg.addRegexPattern("users", "@" + USER_PREFIX + ".*", true);
        console.log(
            "Generating registration to '%s' for the AS accessible from: %s",
            REGISTRATION_FILE, appServiceUrl
        );
        callback(reg);
    },
    run: runBridge
});

c.run(); // check system args
