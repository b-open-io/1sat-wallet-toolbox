import { OneSatServices } from "./src/services/OneSatServices";

async function main() {
  const services = new OneSatServices("main");

  console.log("Testing ChaintracksClient.findChainTipHeader()...\n");

  // Call it 3 times with a small delay
  for (let i = 1; i <= 3; i++) {
    const header = await services.chaintracks.findChainTipHeader();
    console.log(`Call ${i}:`, JSON.stringify(header, null, 2));
    console.log("");

    if (i < 3) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  services.close();
}

main().catch(console.error);
