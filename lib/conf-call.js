"use strict";

function ConferenceCall(fsUserId, ext) {
    this.ext = ext;
    this.fsUserId = fsUserId;
    this.mxCallsByVertoCallId = {};
    this.mxCallsByMatrixCallId = {};
    this.mxCallsByUserId = {};
    console.log("Init verto call for fs_user %s", fsUserId);
}

ConferenceCall.prototype.getAllMatrixSides = function() {
    var self = this;
    return Object.keys(this.mxCallsByUserId).map(function(userId) {
        return self.mxCallsByUserId[userId];
    });
};

ConferenceCall.prototype.getByUserId = function(userId) {
    return this.mxCallsByUserId[userId];
};

ConferenceCall.prototype.getByVertoCallId = function(callId) {
    return this.mxCallsByVertoCallId[callId];
};

ConferenceCall.prototype.getByMatrixCallId = function(callId) {
    return this.mxCallsByMatrixCallId[callId];
};

ConferenceCall.prototype.addMatrixSide = function(data) {
    this.mxCallsByUserId[data.mxUserId] = data;
    this.mxCallsByVertoCallId[data.vertoCallId] = data;
    this.mxCallsByMatrixCallId[data.mxCallId] = data;
    console.log("Add matrix side for fs_user %s (%s)", this.fsUserId, data.mxUserId);
};

ConferenceCall.prototype.removeMatrixSide = function(data) {
    delete this.mxCallsByVertoCallId[data.vertoCallId];
    delete this.mxCallsByMatrixCallId[data.mxCallId];
    delete this.mxCallsByUserId[data.mxUserId];
    console.log(
        "Removed matrix side for fs_user %s (%s)", this.fsUserId, data.mxUserId
    );
};

ConferenceCall.prototype.getNumMatrixUsers = function() {
    return Object.keys(this.mxCallsByUserId).length;
};

module.exports = ConferenceCall;
