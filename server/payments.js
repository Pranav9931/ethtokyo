// On-chain WLD payouts on World Chain. The treasury is a plain EOA whose private key lives in .env
// (TREASURY_PRIVATE_KEY, never logged). Every completed job sends an ERC-20 transfer of the reward
// to the worker's payout wallet.
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, formatUnits, isAddress, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAINS = {
  mainnet: { id: 480, name: 'World Chain', rpc: 'https://worldchain-mainnet.g.alchemy.com/public', token: '0x2cFc85d8E48F8EAB294be644d9E25C3030863003', explorer: 'https://worldscan.org' },
  sepolia: { id: 4801, name: 'World Chain Sepolia', rpc: 'https://worldchain-sepolia.g.alchemy.com/public', token: '0x8803e47fD253915F9c860837f391Aa71B3e03c5A', explorer: 'https://worldchain-sepolia.explorer.alchemy.com' },
};
const ERC20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

export function createPayments(env = process.env) {
  const net = CHAINS[env.WORLD_CHAIN || 'mainnet'] || CHAINS.mainnet;
  const rpc = env.WORLD_CHAIN_RPC || net.rpc;
  const chain = { id: net.id, name: net.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
  const token = getAddress(env.WLD_TOKEN || net.token);
  const transport = http(rpc);
  const pub = createPublicClient({ chain, transport });

  let account = null;
  const key = (env.TREASURY_PRIVATE_KEY || '').trim();
  if (key) {
    try { account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`); }
    catch { console.error('[payments] TREASURY_PRIVATE_KEY is not a valid 32-byte hex key; payouts disabled'); }
  }
  const wallet = account ? createWalletClient({ account, chain, transport }) : null;

  let decimals = 18;
  pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' }).then((d) => { decimals = d; }).catch(() => {});

  const info = () => ({ enabled: !!account, chain: net.name, chainId: net.id, token, treasury: account?.address || null, explorer: net.explorer });

  async function balances() {
    if (!account) return null;
    const [wld, eth] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account.address] }),
      pub.getBalance({ address: account.address }),
    ]);
    return { wld: formatUnits(wld, decimals), eth: formatUnits(eth, 18) };
  }

  // Sends `amount` WLD to `to`. Resolves once the tx is submitted; `confirmed` resolves with the receipt status.
  async function send(to, amount) {
    if (!wallet) throw new Error('payouts disabled: TREASURY_PRIVATE_KEY not set');
    if (!isAddress(to)) throw new Error('invalid payout address');
    const value = parseUnits(String(amount), decimals);
    const hash = await wallet.writeContract({ address: token, abi: ERC20, functionName: 'transfer', args: [getAddress(to), value] });
    const confirmed = pub.waitForTransactionReceipt({ hash, timeout: 180_000 }).then((r) => r.status === 'success');
    return { hash, url: `${net.explorer}/tx/${hash}`, confirmed };
  }

  return { info, balances, send, isAddress };
}
