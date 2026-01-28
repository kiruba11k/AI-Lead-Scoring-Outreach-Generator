FROM apify/actor-node-playwright-chrome:latest

# Copy package.json and install deps
COPY package.json ./
RUN npm install --omit=dev

# Copy rest of the source code
COPY . ./

# Run the actor
CMD ["node", "main.js"]
