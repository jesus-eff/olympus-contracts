/*
 * Idempotently attempt to register NAME.SUBDOMAIN.DOMAIN nodes
 *   - set addr
 *   - set abi, if configured, for JSON and zlib JSON
 *
 * ENV VARS
 *   DOMAIN: parent domain name, default 'olympusdao.eth'
 *   SUBDOMAIN: sub domain label, default 'infra'
 *   TX_CONFIRMATIONS: The number of confirmations to wait for, when writing, default 1
 *   COIN_TYPE: the address type to set for the subdomain, default 60 (ETH)
 *       https://docs.ens.domains/ens-improvement-proposals/ensip-9-multichain-address-resolution#address-encoding
 *       https://github.com/satoshilabs/slips/blob/master/slip-0044.md
 *   DEBUG: if 'true' print debug statements
 *   DRY_RUN: Print, do not do
 *   ENS_REGISTRY_ADDRESS: default is the homestead/rinkeby addr
 *   ENS_RESOLVER_ADDRESS: default is the homestead/rinkeby addr
 *   HARDHAT_NETWORK: network override for the script
 *
 * HARDHAT_NETWORK=rinkeby npx hardhat run scripts/ens-deploy.js
 *
 * TODO Use ENS contract artifacts in @ensdomains/ens-contracts
 *
 * YOU write out the constants from olympus-frontend/src/constants.ts to tmp/addresses.json
 *   TODO transpile constants.ts ...
 *   TODO eentually, constants.ts will use names, contract source of truth?
 * Tries to use hre.config.namedAccounts.deployer.default as the signer
 *   Otherwise first signer is used
 * Checks DOMAIN (olympusdao.eth) is registered
 *   If unregistered, must be registered manually
 *   https://app.ens.domains/name/olympusdao.eth/register
 * Check SUDOMAIN (infra.olympusdao.eth) is registered
 *   script attempts to register subdomain, doesn't matter what ETH addr resolves to
 *   https://app.ens.domains/name/olympusdao.eth/subdomains
 * Parse tmp/addresses.json {CONST_NAME: ADDRESS, ...}
 *   For each pair, check if it is registered
 *     If not, register and set address
 *     If ens.abiMapping.CONST_NAME is defined, set ABI
 * Print gas usage
 */
const zlib = require('zlib');
const fs = require('fs');
const hre = require('hardhat');
const config = hre.network.config;
const ethers = require('ethers');
const utils = ethers.utils;
const namehash = require('eth-ens-namehash');

const RED="\x1b[31m";
const BLUE="\x1b[34m";
const YELLOW="\x1b[33m";
const END="\033[m";
// only DRY_RUN=true prevents contract writes
const DRY_RUN = process.env.DRY_RUN ? process.env.DRY_RUN == "true" : false
// only DEBUG=true triggers debug output
const DEBUG = process.env.DEBUG ? process.env.DEBUG == "true" : false
const domain = process.env.DOMAIN ? process.env.DOMAIN : 'olympusdao.eth';
const subDomain = process.env.SUBDOMAIN ? process.env.SUBDOMAIN : 'infra';
const subName = subDomain + '.' + domain;
const ens = {
  registryAddr: process.env.ENS_REGISTRY_ADDRESS ? process.env.ENS_REGISTRY_ADDRESS : "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
  resolverAddr: process.env.ENS_RESOLVER_ADDRESS ? process.env.ENS_RESOLVER_ADDRESS : "0xf6305c19e814d2a75429Fd637d01F7ee0E77d615",
  gasUnit: 'gwei',
  txConfirmations: process.env.TX_CONFIRMATIONS ? Number(process.env.TX_CONFIRMATIONS) : 1,
  // ens setAddr 60 is ETH
  coinType: process.env.COIN_TYPE ? Number(process.env.COIN_TYPE) : 60,
  // https://docs.ens.domains/ens-improvement-proposals/ensip-4-support-for-contract-abis
  // 1 JSON, 2 zlib JSON, 4 CBOR, 8 URI
  ABIFormats: 1|2,
  ens: undefined,
  resolver: undefined,
  owner: undefined,
  gasPriceAvg: {"setSubnodeRecord": [], "setAddr": [], "setABI": []},
  gasLimitTotal: {"setSubnodeRecord": ethers.BigNumber.from(0), "setAddr": ethers.BigNumber.from(0), "setABI": ethers.BigNumber.from(0)},
  gasUsedTotal: {"setSubnodeRecord": ethers.BigNumber.from(0), "setAddr": ethers.BigNumber.from(0), "setABI": ethers.BigNumber.from(0)},
  txTotal: 0,
  txFeeTotal: ethers.BigNumber.from(0),
  warnings: 0,
  errors: 0,
  abiMapping: {
    "BONDINGCALC_ADDRESS": "OlympusBondingCalculator",
    "DISTRIBUTOR_ADDRESS": "Distributor",
    "GOHM_ADDRESS": "gOHM",
    "MIGRATOR_ADDRESS": "OlympusTokenMigrator",
    // shares the same contract name as ohm-v2
    //"OHM_ADDRESS": ,
    "OHM_V2": "OlympusERC20Token",
    // same contract name as sohm-v2
    // "OLD_SOHM_ADDRESS": ,
    // same contract name as sohm-v2
    // "OLD_STAKING_ADDRESS": ,
    // does not exist
    // "REDEEM_HELPER_ADDRESS": "RedeemHelper",
    // same contract name as sohm-v2
    //"SOHM_ADDRESS": ,
    "SOHM_V2": "sOlympus",
    // same contract name as staking-v2
    // "STAKING_ADDRESS": ,
    "STAKING_V2": "OlympusStaking",
    // does not exist
    // "STAKING_HELPER_ADDRESS": "StakingHelper",
    // same contract name as treasury-v2
    // "TREASURY_ADDRESS": ,
    "TREASURY_V2": "OlympusTreasury",
    "WSOHM_ADDRESS": "wOHM"
  },
};

function getENSABI(type, contract) {
  var path = 'node_modules/@ensdomains/ens-contracts/artifacts/contracts/'+type+'/'+contract+'.sol/'+contract+'.json';
  var parsed = JSON.parse(fs.readFileSync(path));
  return parsed.abi;
};

async function main() {
  var ensABI = getENSABI('registry', 'ENS');
  var resolverABI = getENSABI('resolvers', 'PublicResolver');
  ens.owner = await deployer();
  ens.ens = await hre.ethers.getContractAt(ensABI, ens.registryAddr, ens.owner);
  ens.resolver = await hre.ethers.getContractAt(resolverABI, ens.resolverAddr, ens.owner);
  
  fs.access('tmp/addresses.json', fs.R_OK, (err) => {
    if(err) {
      error("tmp/addresses.json does not exist\nYou need to convert olympus-frontend/src/constants.ts for " + hre.network.name);
      printStats(1);
    }
  });

  if (await nameExists(domain)) {
    console.log("name is registered: %s", domain);
  } else {
    error("You must register at https://app.ens.domains/name/"+domain+"/register network "+hre.network.name+"\nThen run this script again");
    printStats(1);
  }

  if(await setSubnode(subDomain, domain) == undefined) {
    printStats(1);
  }
  await checkSubDomains(subName);
};

/*
 * Does the name exist in ENS
 * @param name string ENS node name
 */
async function nameExists(name) {
  var node = namehash.hash(name);
  debug("\tnamehash name " + name + " " + node);
  return await ens.ens.recordExists(node)
    .catch((err) => {
      error(err);
      printStats(1);
    });
};

/*
 * make sure the subnode is correctly configured
 * when a subnode is deleted, the record is not deleted
 *   the owner is set to zero address
 *   the resolver is set to zero address
 * @param name string ENS node name
 */
async function subNodeConfigured(name) {
  var node = namehash.hash(name);
  if(await ens.ens.owner(node) !== ens.owner.address)
    return false;
  if(await ens.ens.resolver(node) !== ens.resolver.address)
    return false;
  return true;
};

/*
 * register a subnode if it does not exist
 * @param leaf string subdomain to create
 * @param parent string parent domain leaf is prepended to
 * @param addr string|undefined optionally set node's ETH address
 * @param konst string|undefined optionally pass a constant name (key in addresses.json)
 */
async function setSubnode(leaf, parent, addr=undefined, konst=undefined) {
  var leafName = leaf + '.' + parent;
  var nodeLeafName = namehash.hash(leafName);
  var r = true;
  var a;

  if (await nameExists(leafName) && await subNodeConfigured(leafName)) {
    console.log("\tleaf exists: %s", leafName);
  } else {
    console.log("\tleaf does not exist: %s", leafName);
    // parent, infra.olympusdao.eth
    var node = namehash.hash(parent);
    debug("\tnamehash parent " + parent + " " + node);
    // leaf we're attaching to parent, ie sohm-v2 
    var label = utils.id(leaf);
    debug("\tlabelhash " + leaf + " " +label);
    // will form record for sohm-v2.infra.olympusdao.eth
    // setSubnodeRecord(node, label, owner, resolver, ttl)
    if (DRY_RUN) {
      console.log("DRY_RUN await ens.ens.setSubnodeRecord(%s, %s, %s, %s, 0)", node, label, ens.owner.address, ens.resolver.address);
    } else {
      var r = await ens.ens.setSubnodeRecord(node, label, ens.owner.address, ens.resolver.address, 0);
      if(r == undefined) {
        error("Failed to setSubnodeRecord for leaf " + leafName + " ("+addr+")");
        return undefined;
      }
      console.log("\tsetSubnodeRecord successful for %s", leafName);
      await addStats("setSubnodeRecord", r);
    }
  }

  // SUBDOMAIN.DOMAIN does not require addr or abi
  if (addr) {
    try {
      await setAddr(leafName, nodeLeafName, addr);
      await setABI(leafName, nodeLeafName, konst, addr);
    } catch(err) {
      error(err);
    }
  }

  return r;
};

function error(str) {
  ens.errors++;
  console.error(RED + "ERROR " + str + END);
};

function debug(str) {
  if(DEBUG) console.log("DEBUG %s", str);
}

/*
 * Ensure ABI is supported by resolver
 * Ensure constant has an associated contract
 * Configure ABI formats in ens.ABIFormats
 * @param name string ENS node name
 * @param node string ENS namehash of name
 * @param konst string ens.abiMapping key
 * @param data string|undefined URI for abi type 8
 */
async function setABI(name, node, konst, data = undefined) {
  var a;
  if(ens.abiMapping[konst] == undefined) {
    console.log("\t%s contract not configured, ABI not managed", konst);
    return;
  }

  // you're supposed to make sure the interface is supported, no assumptions
  var supported = await ens.resolver['supportsInterface(bytes4)'](0x2203ab56);
  if (!supported) {
    console.log(YELLOW + "\tWARN resolver %s does not support ABI" + END, ens.resolver.address);
    ens.warnings++;
    return;
  }

  for(let abiType of [1, 2, 4, 8]) {
    var srcBytes, bytes, a;
    if ((abiType & ens.ABIFormats) !== abiType) {
      debug("\tskipping ENS ABI format " + abiType);
      continue;
    }

    if (abiType == 1 || abiType == 2) {
      srcBytes = await getABIArtifact(ens.abiMapping[konst], abiType);

    } else if (abiType == 8) {
      if (data == undefined) {
        error("Missing ABI data (URI) for " + name);
        continue;
      }
      srcBytes = data;

    } else {
      error("ABI format " + abiType + " not supported");
      continue;
    }
    bytes = ethers.utils.hexlify(ethers.utils.toUtf8Bytes(srcBytes));

    if ((a=await getABIChain(node, abiType, false)) == bytes) {
      console.log("\t%s resolves to correct ABI for type %d", name, abiType);
    } else {
      debug("\tChain ABI\n" + a);
      debug("\tArtifact ABI\n" + bytes);
      console.log("\t%s resolves to incorrect ABI for type %d", name, abiType);
      if (DRY_RUN) {
        console.log("DRY_RUN await ens.resolver['setABI(bytes32,uint256,bytes)'](%s, %s, %s)", node, abiType, bytes);
      } else {
        a = await ens.resolver['setABI(bytes32,uint256,bytes)'](node, abiType, bytes)
          .catch((err) => error("setABI " + err));
        if (a !== undefined)
          await addStats("setABI", a, ens.txConfirmations);
      }
    }
  }
};

/*
 * return an ethers Interface of the artifact abi
 * @param artifactName string a hardhat contract artifact name
 */
async function getInterface(artifactName) {
  return await hre.artifacts.readArtifact(artifactName)
    .then((artifact) => new ethers.utils.Interface(artifact.abi));
}

/*
 * get ABI from artifact
 * TODO can binary data, ie gzip, be stored on chain
 * seems silly to base64 results...
 * @param contractName string hardhat artifact name
 * @param abiType number ENS ABI type
 */
async function getABIArtifact(contractName, abiType) {
  return await getInterface(contractName)
    .then((iface) => {
      var srcBytes = iface.format(ethers.utils.FormatTypes.json);
      if(abiType == 2) {
        srcBytes = zlib.gzipSync(srcBytes).toString('base64');
      }
      return srcBytes;
    });
};

/*
 * Will return the decoded string, but set decode to false and you get hex string
 * get the on chain ABI and decode it
 * gzip data is base64 encoded... should it be?
 * @param node string ENS namehash of the node name
 * @param abiType number ENS ABI type
 * @param decode boolean decode ABI record
 */
async function getABIChain(node, abiType, decode=true) {
  // returns array ABI type and hexlify'd bytes
  var [_, hex] = await ens.resolver['ABI(bytes32,uint256)'](node, abiType);
  if (!decode)
    return hex;
  var str = ethers.utils.toUtf8String(hex);
  // non-existent record hex=0x, or empty str, don't gunzip that
  if (abiType == 2 && str !== '') {
    var s = ethers.utils.base64.decode(str);
    try {
      str = zlib.gunzipSync(s).toString();
    } catch(err) {
      error("getABIChain gunzipSync " + err);
      return undefined;
    }
  }
  return str;
};


/*
 * Idempotently set the address for an ENS record
 * Makes use of ens.coinType
 * @param name string ENS node name
 * @param node string ENS namehash of name
 * @param addr string blockchain address
 */
async function setAddr(name, node, addr) {
  var a;
  debug("\tchecking " + name + " namehash " + node + " for addr " + addr);
  if ((a = await addrsMatch(node, addr))) {
    console.log("\t%s resolves to correct address %s", name, a);
  } else {
    console.log("\t%s resolves incorrectly to address %s", name, a);
    if (DRY_RUN) {
      console.log("DRY_RUN await ens.resolver['setAddr(bytes32,uint256,bytes)'](%s, %d, %s)", node, ens.coinType, addr);
    } else {
      // setAddr(node, coinType (60=ETH), a (bytes))
      a = await ens.resolver['setAddr(bytes32,uint256,bytes)'](node, ens.coinType, addr)
        .catch((err) => error(err));
      if(a == undefined) {
        error("Failed to setAddr for leaf " + name + " ("+ addr +")");
        return undefined;
      }
    }
    await addStats("setAddr", a, ens.txConfirmations);
  }
};

/*
 * @param node string ENS namehash the name to check
 * @param addr string blockchain address
 */
async function addrsMatch(node, addr) {
  // addr case can be mixed, those are checksum addresses
  // so toLowerCase() everything ... apples to apples
  var nodeAddr = await ens.resolver['addr(bytes32)'](node);
  debug("addrsMatch nodeAddr " + nodeAddr + " addr " + addr);
  return nodeAddr.toLowerCase() == addr.toLowerCase() ? addr : undefined;
};

/*
 * Iterate through tmp/addresses.json, idempotently configuring records
 * @param parent string SUBDOMAIN.DOMAIN
 */
async function checkSubDomains(parent) {
  // addresses.json: { "CONSTANT_NAME1": "ADDRESS1", "CONSTANT_NAME2": "ADDRESS2"}
  var appAddresses = JSON.parse(fs.readFileSync('tmp/addresses.json', 'utf-8'));
  debug(appAddresses);
  
  for(const [konst, addr] of Object.entries(appAddresses)) {
    var leaf, m;
    debug(konst + "\t" + addr);
    // try to standardize naming, based on current constants
    // TREASURY_ADDRESS becomes treasury-v1
    if (m=konst.match(/(.*)_ADDRESS$/)) {
      leaf = m[1] + '-v1';
    // TREASURY_V2 becomes treasury-v2
    } else {
      leaf = konst;
    }
    leaf = leaf.toLowerCase().replace(/_/g, '-');

    console.log(BLUE + "Checking %s %s.%s == %s" + END, konst, leaf, parent, addr);
    await setSubnode(leaf, parent, addr, konst);
  }
}

/*
 * Attempt to find the deployer account
 * If the namedAccount is not defined, default to first signer
 */
async function deployer() {
  var signers = await hre.ethers.getSigners();
  var na = hre.config.namedAccounts;
  var idx = 0;
  if (na && na.deployer && na.deployer.default)
    idx = Number(na.deployer.default);
  return signers[idx];
};

/*
 * Collect network tx stats
 * @param key string ens gas tracking key
 * @param response TransactionResponse
 * @param confs number number of tx confirmations to wait for
 */
async function addStats(key, response, confs = 1) {
  console.log("\tWaiting for %d confirmations", confs);
  var receipt = await response.wait(confs);
  debug("addStats key " + key + " response " + response.blockNumer);
  ens.txTotal++;
  ens.gasPriceAvg[key].unshift(response.gasPrice);
  ens.gasLimitTotal[key] = ens.gasLimitTotal[key].add(response.gasLimit);
  ens.gasUsedTotal[key] = ens.gasUsedTotal[key].add(receipt.gasUsed);
  ens.txFeeTotal = ens.txFeeTotal.add(receipt.gasUsed.mul(ens.gasPriceAvg[key][0]));
  debug("limit total " + ens.gasLimitTotal[key] + " price avg " + ens.gasPriceAvg[key][0] + " used total " + ens.gasUsedTotal[key]);
};

/*
 * print network stats and exit
 * @param ex number exit code
 */
function printStats(ex=0) {
  var entries = Object.entries(ens.gasLimitTotal);
  var total = ethers.BigNumber.from(0);

  if(ens.txTotal < 1) {
    console.log("No transactions recorded");
    console.log(YELLOW + "total warnings %d" + END, ens.warnings);
    console.log(RED + "total errors %d" + END, ens.errors);
    return;
  }

  if(DEBUG) {
    var entries = Object.entries(ens.gasPriceAvg);
    for(const [tx, avg] of entries) {
      if(avg.length == 0) {
        console.log("gas price average %s: 0", tx);
        continue;
      }
      var s = avg.reduce((a,b) => a.add(b), ethers.BigNumber.from(0));
      var u = utils.formatUnits(s, ens.gasUnit);
      console.log("gas price average %s: %d %s", tx, u/avg.length, ens.gasUnit);
    };

    var values = Object.values(ens.gasLimitTotal);
    total = values.reduce((a,b) => a.add(b), ethers.BigNumber.from(0));
    if (total.gt(0))
      console.log("Gas limit total: %d", total);

    values = Object.values(ens.gasUsedTotal);
    total = values.reduce((a,b) => a.add(b), ethers.BigNumber.from(0));
    if (total.gt(0))
      console.log("Gas used total: %d", total);

    entries = Object.entries(ens.gasUsedTotal);
    for(const [tx, _] of entries) {
      console.log("%s total %d used %d (%f%%)",
        tx, 
        ens.gasLimitTotal[tx], 
        ens.gasUsedTotal[tx], 
        ens.gasLimitTotal[tx]/ens.gasUsedTotal[tx]
      );
    };
  }

  console.log("names created %d", ens.gasPriceAvg["setSubnodeRecord"].length);
  console.log("addresses upserted %d", ens.gasPriceAvg["setAddr"].length);
  console.log("ABIs upserted %d", ens.gasPriceAvg["setABI"].length);
  console.log("total transactions %d", ens.txTotal);
  console.log("total fees %d %s", utils.formatUnits(ens.txFeeTotal, ens.gasUnit), ens.gasUnit);
  console.log(YELLOW + "total warnings %d" + END, ens.warnings);
  console.log(RED + "total errors %d" + END, ens.errors);
  process.exit(ex);
};

main()
  .then(() => printStats())
  .catch((err) => {
    console.log(err);
    printStats(1);
  });
