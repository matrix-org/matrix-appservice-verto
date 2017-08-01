"use strict";

function CallStore(prefix) {
    this.confUserToConf = {}; // confUserId: sipCall
    this.extToConf = {}; // ext: sipCall
    this.currentExtension = "00";
    this.extPrefix = prefix || "35";
}

CallStore.prototype.set = function(sipCall) {
    this.extToConf[sipCall.ext] = sipCall;
    this.confUserToConf[sipCall.confUserId] = sipCall;
    console.log(
        "Storing sip call on ext=%s conf_user=%s matrix_users=%s",
        sipCall.ext, sipCall.confUserId, sipCall.getNumMatrixUsers()
    );
};

CallStore.prototype.delete = function(sipCall, matrixSide) {
    sipCall.removeMatrixSide(matrixSide);
    if (sipCall.getNumMatrixUsers() === 0) {
        console.log("Deleting conf call for conf_user %s", sipCall.confUserId);
        delete this.extToConf[sipCall.ext];
        delete this.confUserToConf[sipCall.confUserId];
    }
};

CallStore.prototype.getBySipCallId = function(sipCallId) {
    var exts = Object.keys(this.extToConf);
    var matrixSide, sipCall;
    for (var i = 0; i < exts.length; i++) {
        var c = this.extToConf[exts[i]];
        matrixSide = c.getBySipCallId(sipCallId);
        if (matrixSide) {
            sipCall = c;
            break;
        }
    }
    return {
        matrixSide: matrixSide,
        sipCall: sipCall
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
        var sipCall = this.extToConf[this.extPrefix + extStr];
        if (!sipCall) {
            return this.extPrefix + extStr;
        }
    }
    throw new Error("No free extensions");
};

module.exports = CallStore;
