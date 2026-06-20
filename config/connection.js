const { MongoClient } = require("mongodb");

const state = {
  db: null,
  client: null,
  connecting: null,
};

const url = process.env.MONGO_URL || "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGO_DB_NAME || "lms-platform";

const client = new MongoClient(url, {
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10000,
  maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 20,
});

// function to establish mongodb connection
const connect = async (cb) => {
  const done = typeof cb === "function" ? cb : () => {};

  try {
    if (state.db) return done();

    if (!state.connecting) {
      state.connecting = client.connect().then(() => {
        state.client = client;
        state.db = client.db(dbName);
        return state.db;
      });
    }

    await state.connecting;
    return done();
  } catch (err) {
    state.connecting = null;
    return done(err);
  }
};

// function to get the database instance
const get = () => state.db;

const close = async () => {
  if (state.client) {
    await state.client.close();
  }
  state.db = null;
  state.client = null;
  state.connecting = null;
};

// exporting functions
module.exports = {
  connect,
  get,
  close,
};
