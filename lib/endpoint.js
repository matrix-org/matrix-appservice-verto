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
}

VertoEndpoint.prototype.login = function(user, pass) {
    var self = this;
    var defer = Promise.defer();
    this.ws = new WebSocket(this.url);
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

    var enoughCandidates = false;
    for (var i = 0; i < matrixSide.candidates.length; i++) {
        var c = matrixSide.candidates[i];
        if (!c.candidate) { continue; }
        // got enough candidates when SDP has a srflx or relay candidate
        if (c.candidate.indexOf("typ srflx") !== -1 ||
                c.candidate.indexOf("typ relay") !== -1) {
            enoughCandidates = true;
            console.log("Gathered enough candidates for %s", matrixSide.mxCallId);
            break; // bail early
        }
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
            else if (cand.sdpMid !== undefined && cand.sdpMid === mType) {
                // insert candidate f.e. m= type (e.g. audio)
                // This will repeatedly insert the candidate for m= blocks with
                // the same type (unconfirmed if this is the 'right' thing to do)
                line = "a=" + cand.candidate + "\r\n" + line;
                console.log(
                    "Inserted candidate %s at m= type %s",
                    cand.candidate, cand.sdpMid
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