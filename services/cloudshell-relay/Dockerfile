# Use Google Cloud SDK image which includes gcloud CLI
FROM google/cloud-sdk:slim

# Install Node.js
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

# Create workspace directory
WORKDIR /app

# Copy service files
COPY package.json ./
COPY index.js ./

# Create workspace for command execution
RUN mkdir -p /workspace

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "index.js"]
