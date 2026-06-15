FROM node:22-alpine

WORKDIR /app

# Install meshmind globally
RUN npm install -g meshmind

# Start the MCP server over stdio
ENTRYPOINT ["meshmind"]
