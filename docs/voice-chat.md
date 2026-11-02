# Simple Voice Chat with Playit

Stop the Minecraft server, then open its Settings. Set **Voice chat host UDP port** to `24454` and save. The panel recreates the stopped container with host UDP port 24454 mapped to container UDP port 24454. Your server files stay in their existing data mount. Start the server after saving.

Install Simple Voice Chat on the server and on each player's client. In `config/voicechat/voicechat-server.properties` (or `plugins/voicechat/voicechat-server.properties` for the plugin), use `port=24454`. Leave `bind_address` blank or use `*`. Set `voice_host` to your voice tunnel's public address **including its public port**.

Create a Playit UDP tunnel. Its Local IP must reach the CasaOS host from the Playit agent; for an agent on another computer, use the CasaOS LAN IP rather than 127.0.0.1. Its Local Port must match the panel's **host UDP port**. Your existing Minecraft TCP tunnel and game domain stay usable.

For additional servers choose unused host UDP ports, such as 24455 and 24456. Each server's internal voice port remains 24454. Give each server its own UDP tunnel pointing to its assigned host port. The panel rejects a host voice port already assigned to another server. Docker also reports conflicting host bindings when starting.

Clearing the field disables UDP publishing after saving while stopped. This setting publishes the network port; it does not install the mod or change its configuration. Test from a client with the matching mod and inspect the voice chat startup logs if it cannot connect.
