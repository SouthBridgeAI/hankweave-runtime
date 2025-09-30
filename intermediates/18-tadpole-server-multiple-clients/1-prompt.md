This is the project we are working on. Check @README.md to indications on how to work with this codebase. `documentation` directory is a good place to get more information on the design and implementation details.

Today will focus on modifying the behavior of Tadpole server located in @server/tadpole-server.ts. Specifically, we want to allow multiple clients to connect to the server, send commands (both read and write) and receive updates. When clients connect, the handshake is them setting whether they want to be read-only, and getting a dump of all the packets before they connected.

Your task is to carefully study current implementation and provide a detailed plan with relevant code snippets on how to implement this feature. We are looking for something simple and yet powerful as well as resilient to conflicts and race conditions.
