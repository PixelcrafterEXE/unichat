// hyperdht ships no types; dht.ts talks to it through `any` on purpose (it is loaded lazily and may be missing on a platform).
declare module "hyperdht";
declare module "hyperdht/testnet";
