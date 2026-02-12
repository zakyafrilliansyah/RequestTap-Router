require("@nomicfoundation/hardhat-toolbox");
require("dotenv/config");

/** @type {import("hardhat/config").HardhatUserConfig} */
const config = {
  solidity: "0.8.20",
  paths: {
    sources: "./src",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  networks: {
    skaleCalypso: {
      url: "https://testnet.skalenodes.com/v1/giant-half-dual-testnet",
      chainId: 974399131,
      accounts: process.env.SKALE_PRIVATE_KEY
        ? [process.env.SKALE_PRIVATE_KEY]
        : [],
    },
  },
};

module.exports = config;
