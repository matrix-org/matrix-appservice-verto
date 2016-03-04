var Promise = require("bluebird");
var WebSocket = require('ws');
var uuid = require("uuid");
var CANDIDATE_TIMEOUT_MS = 1000 * 3; // 3s

function VertoEndpoint(url, dialogParams, callback) {
    this.url = url;
    this.ws = null;
    this.sessionId = uuid.v4();
    this.callback = callback;
    this.requestId = 0;
    this.requests = {};
    this.dialogParams = dialogParams;
    this._inQuietTime = false;
}

VertoEndpoint.prototype.login = function(user, pass) {
    var self = this;
    self._inQuietTime = false;
    var defer = Promise.defer();
    this.ws = new WebSocket(this.url);
    this.ws.on("error", function(err) {
        console.error("[%s]: ERROR: %s", self.url, err);
        if (defer.promise.isPending()) {
            defer.reject(err);
        }
        if (self._inQuietTime) {
            return;
        }
        self._inQuietTime = true;
        try {
            self.ws.terminate(); // make sure the conn is dead
        }
        catch (e) {
            console.error("[%s]: Failed to terminate() connection. %s", self.url, e);
        }
        setTimeout(function() {
            self.login(user, pass);
        }, 30 * 1000);
    });
    this.ws.on("close", function(code, msg) {
        console.error("[%s]: CLOSE: %s %s", self.url, code, msg);
        if (self._inQuietTime) {
            return;
        }
        self._inQuietTime = true;
        setTimeout(function() {
            self.login(user, pass);
        }, 30 * 1000);
    });
    this.ws.on('open', function() {
        console.log("[%s]: OPENED", self.url);
        self.sendRequest("login", {
            login: user,
            passwd: pass,
            sessid: self.sessionId
        }).done(function() {
            defer.resolve();
        }, function(err) {
            defer.reject(err);
        });
    });
    this.ws.on('message', function(message) {
        console.log("[%s]: MESSAGE %s\n", self.url, message);
        var jsonMessage;
        try {
            jsonMessage = JSON.parse(message);
        }
        catch(e) {
            console.error("Failed to parse %s: %s", message, e);
            return;
        }
        var existingRequest = self.requests[jsonMessage.id];
        if (existingRequest) {  // check for promises to resolve/reject
            if (jsonMessage.error) {
                existingRequest.reject(jsonMessage.error);
            }
            else if (jsonMessage.result) {
                existingRequest.resolve(jsonMessage.result);
            }
        }
        else if (jsonMessage.method) {
            self.callback(jsonMessage);
        }
    });
    return defer.promise;
};

VertoEndpoint.prototype.attemptInvite = function(vertoCall, matrixSide, force) {
    if (matrixSide.candidates.length === 0) { return Promise.resolve(); }
    var self = this;

    // see if we've got enough candidates to detrickle correctly.
    // we start off by gathering some stats on the candidates we have:
    // splitting into media sections, do we have host/srflx/relay candidates yet?
    // and sum the component IDs for each foundation (which should sum to 1 or 3
    // depending on whether we've received just RTP or RTP+RTCP)
    var stats = [];

    // pre-parse the SDP invite
    // XXX: this should probably be combined with the later SDP parsing
    var mLineIndex = 0;
    var mLineIndexByMid = {};
    matrixSide.offer.split("\r\n").forEach(function(line) {
        if (line.indexOf("m=") === 0) {
            // create empty stats blocks where we expect to see candidates so we can
            // spot if candidates are entirely missing...
            stats[mLineIndex] = {};
            mLineIndex++;
        }
        // work out a mapping from mIds to mLineIndexes, in case we
        // need to manipulate candidates who have no sdpMLineIndex.
        var m = line.match(/^a=mid:(.*)/); // matching something like a=mid:sdparta_0
        if (m) {
            mLineIndexByMid[m[1]] = mLineIndex;
        }
    });
    
    for (var i = 0; i < matrixSide.candidates.length; i++) {
        var c = matrixSide.candidates[i];
        if (!c.candidate) { continue; }

        var mLineIndex;
        if (c.sdpMLineIndex !== undefined) {
            mLineIndex = c.sdpMLineIndex;
        }
        else {
            if (mLineIndexByMid[c.sdpMid] !== undefined) {
                mLineIndex = mLineIndexByMid[c.sdpMid];
            }
            else {
                console.error("Can't find a m= line for candidate; ignoring: " + c.candidate);
                continue;
            }
        }
        stats[mLineIndex] = stats[mLineIndex] || {};
        if (c.candidate.indexOf("typ host") !== -1) {
            stats[mLineIndex].hasHost = 1;
        }
        if (c.candidate.indexOf("typ srflx") !== -1) {
            stats[mLineIndex].hasSrflx = 1;
        }
        if (c.candidate.indexOf("typ relay") !== -1) {
            stats[mLineIndex].hasRelay = 1;   
        }

        // match the <foundation> and <component-id> of the candidate,
        // in order to check we don't have any gaps in the component-id
        // sequence for each foundation.
        //
        // e.g. "candidate:0 1 UDP 2122252543 131.254.15.55 53897 typ host"
        var m = c.candidate.match(/^candidate:(.*?) (.*?) /);
        if (m) {
            var foundation = m[1];
            var componentId = parseInt(m[2]);
            stats[mLineIndex].componentIdSumByFoundation =
                stats[mLineIndex].componentIdSumByFoundation || {};
            stats[mLineIndex].componentIdSumByFoundation[foundation] =
                stats[mLineIndex].componentIdSumByFoundation[foundation] || 0;
            // N.B. we actually logical-OR rather than add the components
            // as apparently it's valid to have some candidates with the same
            // foundation and component ID...
            stats[mLineIndex].componentIdSumByFoundation[foundation] |= componentId;
        }
        else {
            console.error("Can't parse candidate: " + c.candidate);
        }
    }

    var enoughCandidates = true; // start off optimistic...
    stats.forEach(function(stat, index) {
        // we've gathered enough candidates when've received srflx or relay candidates
        //
        // this works because if we've got a srflx, we will always be able to use it
        // given we know that the freeswitch isn't NATted - so if a NATted client
        // is able to correctly discover a srflx candidate, it should also be able to
        // talk through to FS.
        //
        // Similarly, if we've seen a relay candidate (which are typically the slowest
        // to set up and last to arrive), we know that will always work too, so we don't
        // need to wait for any others.
        //
        // Meanwhile if we haven't seen any host candidates then something has gone very
        // wrong (we've probably lost some m.call.candidate events) given every sane
        // ICE stack should generate host candidates.

        if (!stat.hasHost) {            
            enoughCandidates = false;
            console.log("m= line " + index + " has no host candidates yet; waiting...");
        }
        if (!stat.hasSrflx && !stat.hasRelay) {
            enoughCandidates = false;
            console.log("m= line " + index + " has no srflx or relay candidates yet; waiting...");
        }

        // If we see gaps in the candidate component-id sequences then we should
        // definitely hold off until we receive the missing candidates, otherwise
        // freeswitch has been known to segfault

        Object.keys(stat.componentIdSumByFoundation).forEach(function(foundation) {
            // sum must be a triangular number.
            // in practice webrtc only ever uses RTP (1) and RTCP (2), so the sum
            // will normally be 3 (RTP+RTCP) or 1 (just RTP, which is unlikely but
            // possible given any sensible WebRTC stack will speak RTCP)
            var sum = stat.componentIdSumByFoundation[foundation];
            if (sum != 3 && sum != 1) {
                enoughCandidates = false;
                console.log("m= line " + index + " has missing components for foundation " + foundation + ", sum=" + sum + "; waiting...");
            }
        });
    });

    if (enoughCandidates) {
        console.log("Gathered enough candidates for %s", matrixSide.mxCallId);
    }

    if (!enoughCandidates && !force) { // don't send the invite just yet
        if (!matrixSide.timer) {
            matrixSide.timer = setTimeout(function() {
                console.log("Timed out. Forcing invite for %s", matrixSide.mxCallId);
                self.attemptInvite(vertoCall, matrixSide, true);
            }, CANDIDATE_TIMEOUT_MS);
            console.log("Call %s is waiting for candidates...", matrixSide.mxCallId);
            return Promise.resolve("Waiting for candidates");
        }
    }

    if (matrixSide.timer) {  // cancel pending timers
        clearTimeout(matrixSide.timer);
    }
    if (matrixSide.sentInvite) {  // e.g. timed out and then got more candidates
        return Promise.resolve("Invite already sent");
    }

    // de-trickle candidates - insert the candidates in the right m= block.
    // Insert the candidate line at the *END* of the media block
    // (RFC 4566 Section 5; order is m,i,c,b,k,a) - we'll just insert at the
    // start of the a= lines for parsing simplicity)
    var mIndex = -1;
    var mType = "";
    var parsedUpToIndex = -1;
    matrixSide.offer = matrixSide.offer.split("\r\n").map(function(line) {
        if (line.indexOf("m=") === 0) { // m=audio 48202 RTP/SAVPF 111 103
            mIndex += 1;
            mType = line.split(" ")[0].replace("m=", ""); // 'audio'
            console.log("index=%s - %s", mIndex, line);
        }
        if (line.indexOf("c=") === 0) {
            //  ================= HACK ================================
            // Freeswitch special cases 0.0.0.0 for putting calls on hold
            // in line with an old SIP RFC 2543:
            // https://tools.ietf.org/html/rfc2543#appendix-B.5
            // This is not recommended anymore as per the updated RFC 3264:
            // https://tools.ietf.org/html/rfc3264#section-8.4
            //
            // This manifests itself as receiving a=sendonly in the answer SDP
            // instead of a=sendrecv - for audio only.
            //
            // This hack fixes this by clobbering 0.0.0.0 with an unroutable IP
            // instead.
            //
            // Verified affected version: freeswitch.git (Aug 5 2015 checkout)
            // hash b5b7740a1de5ac9737126ccd7f00da5e1bddb127
            line = line.replace("0.0.0.0", "10.10.10.10");
        }

        if (mIndex === -1) { return line; } // ignore session-level keys
        if (line.indexOf("a=") !== 0) { return line; } // ignore keys before a=
        if (parsedUpToIndex === mIndex) { return line; } // don't insert cands f.e a=

        matrixSide.candidates.forEach(function(cand) {
            // m-line index is more precise than the type (which can be multiple)
            // so prefer that when inserting
            if (typeof(cand.sdpMLineIndex) === "number") {
                if (cand.sdpMLineIndex !== mIndex) {
                    return;
                }
                line = "a=" + cand.candidate + "\r\n" + line;
                console.log(
                    "Inserted candidate %s at m= index %s",
                    cand.candidate, cand.sdpMLineIndex
                );
            }
            else if (cand.sdpMid !== undefined &&
                     mLineIndexByMid[cand.sdpMid] !== undefined) {

                var mLineIndex = mLineIndexByMid[cand.sdpMid];
                if (mLineIndex !== mIndex) {
                    return;
                }
                line = "a=" + cand.candidate + "\r\n" + line;
                console.log(
                    "Inserted candidate %s at m= with index %s calculated from mId %s",
                    cand.candidate, mLineIndex, cand.sdpMid
                );
            }
        });
        parsedUpToIndex = mIndex;
        return line;
    }).join("\r\n");

    matrixSide.sentInvite = true;
    return this.sendRequest("verto.invite", {
        sdp: matrixSide.offer,
        dialogParams: this.getDialogParamsFor(vertoCall, matrixSide),
        sessid: this.sessionId
    });
};

VertoEndpoint.prototype.sendBye = function(vertoCall, callData) {
    return this.sendRequest("verto.bye", {
        dialogParams: this.getDialogParamsFor(vertoCall, callData),
        sessid: this.sessionId
    });
}

VertoEndpoint.prototype.send = function(stuff) {
    console.log("[%s]: SENDING %s\n", this.url, stuff);
    var defer = Promise.defer();
    this.ws.send(stuff, function(err) {
        if (err) {
            defer.reject(err);
            return;
        }
        defer.resolve();
    });
    return defer.promise;
}

VertoEndpoint.prototype.sendRequest = function(method, params) {
    this.requestId += 1;
    this.requests[this.requestId] = Promise.defer();
    // The request is OK if we can send it down the wire AND get
    // a non-error response back. This promise will fail if either fail.
    return Promise.all([
        this.send(JSON.stringify({
            jsonrpc: "2.0",
            method: method,
            params: params,
            id: this.requestId
        })),
        this.requests[this.requestId].promise
    ]);
};

VertoEndpoint.prototype.sendResponse = function(result, id) {
    return this.send(JSON.stringify({
        jsonrpc: "2.0",
        result: result,
        id: id
    }));
};

VertoEndpoint.prototype.getDialogParamsFor = function(vertoCall, callData) {
    var dialogParams = JSON.parse(JSON.stringify(this.dialogParams)); // deep copy
    dialogParams.callID = callData.vertoCallId;
    dialogParams.destination_number = vertoCall.ext;
    dialogParams.remote_caller_id_number = vertoCall.ext;
    dialogParams.caller_id_name = callData.mxUserId;
    return dialogParams;
};

module.exports = VertoEndpoint;
