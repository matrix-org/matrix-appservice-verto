"use strict";
/**
 * @fileoverview MediaHandler
 */

/* MediaHandler
 * @class Signaling helper Class.
 * @param {SIP.Session} session
 * @param {Object} [options]
 */
module.exports = function (SIP) {
var MediaHandler = function(session, options) {
  options = options || {};

  this.logger = session.ua.getLogger('sip.invitecontext.mediahandler', session.id);
  this.session = session;
  this.ready = true;
  this.sdpCallback = options.sdpCallback || function (sdp) {
    this.logger.log("Got SDP:\n" + sdp);
  }
};

MediaHandler.defaultFactory = function defaultFactory (session, options) {
  return new MediaHandler(session, options);
};

MediaHandler.prototype = Object.create(SIP.MediaHandler.prototype, {
  isReady: {writable: true, value: function isReady () {
    return this.ready;
  }},

  close: {writable: true, value: function close () {
  }},

  /**
   * @param {SIP.WebRTC.MediaStream | (getUserMedia constraints)} [mediaHint]
   *        the MediaStream (or the constraints describing it) to be used for the session
   */
  getDescription: {writable: true, value: function getDescription (mediaHint) {
    var self = this;
    mediaHint = mediaHint || {};
    self.mediaHint = mediaHint;

    self.session.connecting();

    return SIP.Utils.Promise.resolve({
      body: self.mediaHint,
      contentType: 'application/sdp'
    });
  }},

  /**
   * Check if a SIP message contains a session description.
   * @param {SIP.SIPMessage} message
   * @returns {boolean}
   */
  hasDescription: {writeable: true, value: function hasDescription (message) {
    return message.getHeader('Content-Type') === 'application/sdp' && !!message.body;
  }},

  /**
   * Set the session description contained in a SIP message.
   * @param {SIP.SIPMessage} message
   * @returns {Promise}
   */
  setDescription: {writable: true, value: function setDescription (message) {
    var sdp = message.body;

    var rawDescription = {
      type: sdp === this.mediaHint ? 'offer' : 'answer',
      sdp: sdp
    };

    this.emit('setDescription', rawDescription);

    this.sdpCallback(sdp);
    return SIP.Utils.Promise.resolve(rawDescription);
  }},

  unmute: {writable: true, value: function unmute () {
  }},

});

// Return since it will be assigned to a variable.
return MediaHandler;
};
