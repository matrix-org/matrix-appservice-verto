# matrix-appservice-verto
A Matrix &lt;--> Verto bridge, designed for conferencing.

## Usage

### Installing

Set up and run a FreeSWITCH 1.6 or later (ideally 1.7).  Make sure `mod_verto` is installed and works with the verto example app (try to join a conference on 3500)

```
$ git clone git@github.com:matrix-org/matrix-appservice-verto.git
$ cd matrix-appservice-verto
$ npm install
```

### Registering
```
$ node app -r -u "http://appservice-url-here"
Generating registration to 'config/verto-registration.yaml' for the AS accessible from: http://appservice-url-here
```
Add `verto-registration.yaml` to Synapse's `homeserver.yaml` config file:
```
# homeserver.yaml
app_service_config_files: ["/path/to/matrix-appservice-verto/config/verto-registration.yaml"]
```

### Configuring
```
$ cp config/config.sample.yaml config/config.yaml
```

```yaml
# config/config.yaml
homeserver:
  url: http://localhost:8008
  domain: localhost

verto:
  url: "ws://freeswitch.url.here:8081/"
  passwd: "1234567890"

verto-dialog-params:
  login: "1008@freeswitch.url.here"
  ...
```

### Running
```
$ node app -c config/config.yaml
Loading config file /path/matrix-appservice-verto/config/config.yaml
[ws://freeswitch.url.here:8081/]: OPENED
[ws://freeswitch.url.here:8081/]: SENDING {"jsonrpc":"2.0","method":"login","params":{"login":"1008@freeswitch.url.here","passwd":"1234567890","sessid":"af5cc400-811c-4c5b-896a-25be7b413f5f"},"id":1}

[ws://freeswitch.url.here:8081/]: MESSAGE {"jsonrpc":"2.0","id":1,"result":{"message":"logged in","sessid":"af5cc400-811c-4c5b-896a-25be7b413f5f"}}

Running bridge on port 8090

```

You can supply `-p PORT` to set a custom port.
