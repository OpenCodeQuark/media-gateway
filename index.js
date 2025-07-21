
import app from "./server.js"; // Import the Express app

import { PORT } from "./config/env.config.js";

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
