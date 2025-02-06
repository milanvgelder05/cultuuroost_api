# 1. Use an official Node.js runtime as a parent image
FROM node:18-slim

# 2. Install FFmpeg (required by fluent-ffmpeg)
RUN apt-get update && apt-get install -y ffmpeg

# 3. Create and switch to a directory for our app code
WORKDIR /usr/src/app

# 4. Copy package.json and package-lock.json (if you have one)
COPY package*.json ./

# 5. Install dependencies
RUN npm install

# 6. Copy the rest of your application code
COPY . .

# 7. Set the environment variable for the port (Azure usually sets this, but it's nice to define)
ENV PORT=3000

# 8. Expose the port - for local docker usage
EXPOSE 3000

# 9. Start the app
CMD ["npm", "start"]
