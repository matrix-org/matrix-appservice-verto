"use strict";

function CallStore(prefix) {
    this.fsUserToConf = {}; // fsUserId: VertoCall
    this.extToConf = {}; // ext: VertoCall
    this.currentExtension = "00";
    this.extPrefix = prefix || "35";
}

CallStore.prototype.set = function(vertoCall) {
    this.extToConf[vertoCall.ext] = vertoCall;
    this.fsUserToConf[vertoCall.fsUserId] = vertoCall;
    console.log(
        "Storing verto call on ext=%s fs_user=%s matrix_users=%s",
        vertoCall.ext, vertoCall.fsUserId, vertoCall.getNumMatrixUsers()
    );
};

CallStore.prototype.delete = function(vertoCall, matrixSide) {
    vertoCall.removeMatrixSide(matrixSide);
    if (vertoCall.getNumMatrixUsers() === 0) {
        console.log("Deleting conf call for fs_user %s", vertoCall.fsUserId);
        delete this.extToConf[vertoCall.ext];
        delete this.fsUserToConf[vertoCall.fsUserId];
    }
};

CallStore.prototype.getByVertoCallId = function(vertoCallId) {
    var exts = Object.keys(this.extToConf);
    var matrixSide, vertoCall;
    for (var i = 0; i < exts.length; i++) {
        var c = this.extToConf[exts[i]];
        matrixSide = c.getByVertoCallId(vertoCallId);
        if (matrixSide) {
            vertoCall = c;
            break;
        }
    }
    return {
        matrixSide: matrixSide,
        vertoCall: vertoCall
    };
};

CallStore.prototype.nextExtension = function() { // loop 0-99 with leading 0
    var nextExt = parseInt(this.currentExtension) + 1;
    if (nextExt >= 100) { nextExt = 0; }
    nextExt = "" + nextExt;
    while (nextExt.length < 2) {
        nextExt = "0" + nextExt;
    }
    this.currentExtension = nextExt;
    return this.extPrefix + nextExt;
};

CallStore.prototype.anyFreeExtension = function() {
    for (var i = 0; i < 100; i++) {
        var extStr = (i < 10 ? "0"+i : i+"");
        var vertoCall = this.extToConf[this.extPrefix + extStr];
        if (!vertoCall) {
            return this.extPrefix + extStr;
        }
    }
    throw new Error("No free extensions");
};

module.exports = CallStore;
