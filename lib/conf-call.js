"use strict";

var Promise = require("bluebird");
var SIP = require("sip.js");
var SignalingMediaHandler = require("./SignalingMediaHandler")(SIP);

function ConferenceCall(confUserId, ext) {
    this.ext = ext;
    this.confUserId = confUserId;
    this.mxCallsBySipCallId = {};
    this.mxCallsByMatrixCallId = {};
    this.mxCallsByUserId = {};
    this.ua = null;
    this.AsDomain = '127.0.0.1';
    this.SipWsUri = 'ws://127.0.0.1:18888';
    this.confServerAddr = '127.0.0.1:9370;transport=tcp';
    console.log("Init sip call for conf_user %s", confUserId);
}

ConferenceCall.prototype.createUa = function(params) {
    var localPart = params.mxUserId.replace(/@([^:]+):.*/, "$1");
    var ua = new SIP.UA({
        uri: localPart + "@" + this.AsDomain,
        // authorizationUser: 'rob',
        // password: 'rob',
        wsServers: this.SipWsUri,
        log: {level: 'debug'},
        register: false,
        mediaHandlerFactory: function mHFactory(session, options) {
            options.sdpCallback = params.sdpCallback;
            return new SignalingMediaHandler(session, options);
        }
    });

    ua.on('invite', function (incomingSession) {
        console.log(this.confUserId + ': Why did I receive an invite?\n' + incomingSession);
    });

    return ua;
};

ConferenceCall.prototype.invite = function(options) {
    var params = options.dialogParams;
    var data = this.mxCallsBySipCallId[params.callID];
    if (data.session) {
        return Promise.reject(new Error("Already in a call. Can't call again."));
    }
    if (!data.ua) {
        return Promise.reject(new Error("Missing User Agent."));
    }
    data.session = data.ua.invite('sip:' + params.destination_number + '@' + this.confServerAddr, {
        media: options.sdp
    });
    data.session.on('bye', function () {
        // signal back to matrix that something caused a hang up
        console.log('We got a bye.');
    });
    return Promise.resolve();
};

ConferenceCall.prototype.sendBye = function(data) {
    if (!data.session) {
        console.log("Cannot BYE, no session");
        return;
    }
    data.session.bye();
};

ConferenceCall.prototype.getAllMatrixSides = function() {
    var self = this;
    return Object.keys(this.mxCallsByUserId).map(function(userId) {
        return self.mxCallsByUserId[userId];
    });
};

ConferenceCall.prototype.getByUserId = function(userId) {
    return this.mxCallsByUserId[userId];
};

ConferenceCall.prototype.getBySipCallId = function(callId) {
    return this.mxCallsBySipCallId[callId];
};

ConferenceCall.prototype.getByMatrixCallId = function(callId) {
    return this.mxCallsByMatrixCallId[callId];
};

ConferenceCall.prototype.addMatrixSide = function(data) {
    data.ua = this.createUa(data);
    this.mxCallsByUserId[data.mxUserId] = data;
    this.mxCallsBySipCallId[data.sipCallId] = data;
    this.mxCallsByMatrixCallId[data.mxCallId] = data;
    console.log("Add matrix side for conf_user %s (%s)", this.confUserId, data.mxUserId);
};

ConferenceCall.prototype.removeMatrixSide = function(data) {
    var ua = this.mxCallsBySipCallId[data.sipCallId].ua;
    if (ua) {
        ua.stop();
    }
    delete this.mxCallsBySipCallId[data.sipCallId];
    delete this.mxCallsByMatrixCallId[data.mxCallId];
    delete this.mxCallsByUserId[data.mxUserId];
    console.log(
        "Removed matrix side for conf_user %s (%s)", this.confUserId, data.mxUserId
    );
};

ConferenceCall.prototype.getNumMatrixUsers = function() {
    return Object.keys(this.mxCallsByUserId).length;
};

module.exports = ConferenceCall;
