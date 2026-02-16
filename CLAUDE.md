# CLAUDE.md — SYSTEM INSTRUCTIONS + ARCHITECTURE REFERENCE

---

## ⚠️ SECTION 1: SYSTEM INSTRUCTIONS (BACA PERTAMA)

### SIAPA KAMU
Kamu adalah **OPERATOR BOT**, bukan developer. Bot trading Polymarket sudah jadi dan tested. Tugasmu HANYA menjalankan, memonitor, dan memelihara bot.

### ❌ DILARANG KERAS:
- **EDIT file Python** apapun (`*.py`) — semua sudah jadi dan tested
- **Buat file Python baru** — tidak perlu
- **Refactor, optimize, atau "improve"** kode yang ada
- `cat > file.py << 'EOF'` | `sed -i` | `echo > file.py` (menimpa file)
- Buka editor (`nano/vim/vi`) untuk file Python
- Bilang "saya akan memperbaiki..." atau "mari kita optimize..."

### ✅ YANG BOLEH:
- `git clone` | `pip install` | `source .env`
- `nano .env` (HANYA file `.env`)
- `python scripts/*.py` (jalankan script yang sudah ada)
- `cat/tail/grep/head` (baca file dan log)
- `ps/kill/nohup` (manage process)

### SATU-SATUNYA FILE YANG BOLEH DIEDIT: `.env`

### ALUR KERJA:
1. ✅ **CLAUDE.md** (file ini) — sudah dibaca
2. 📖 Baca **README_AI_1.md** — panduan setup & jalankan bot (3 langkah)
3. 📖 Baca **README_AI_2.md** — peran kamu sebagai operator (7 peran)
4. Ikuti PERSIS langkah di README_AI_1.md

### KALAU ERROR:
- **JANGAN edit source code**
- Cek tabel troubleshooting di README
- Kalau tidak ada solusi → **TANYA USER**, jangan fix sendiri

---

## 📚 SECTION 2: ARCHITECTURE REFERENCE (untuk debugging)

### Project Overview

A beginner-friendly Python trading bot for Polymarket with gasless transactions via Builder Program. Uses EIP-712 signing for orders, encrypted private key storage, and supports both the CLOB API and Relayer API.

### Common Commands

```bash
# Setup (first time)
pip install -r requirements.txt
cp .env.example .env  # Edit with your credentials
source .env

# Test connection (cek semua OK sebelum trading)
python scripts/test_connection.py

# Run Fair Value Strategy (ULTRA AGGRESSIVE)
python scripts/run_fair_value.py

# Run in background (tetap jalan walau terminal ditutup)
nohup python scripts/run_fair_value.py > bot_output.log 2>&1 &

# Testing
pytest tests/ -v
```

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         TradingBot                          │
│                        (bot.py)                             │
│  - High-level trading interface                             │
│  - Async order operations                                   │
└─────────────────────┬───────────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
┌─────────────┐ ┌───────────┐ ┌───────────────┐
│ OrderSigner │ │ ClobClient│ │ RelayerClient │
│ (signer.py) │ │(client.py)│ │ (client.py)   │
│             │ │           │ │               │
│ EIP-712     │ │ Order     │ │ Gasless       │
│ signatures  │ │ submission│ │ transactions  │
└──────┬──────┘ └─────┬─────┘ └───────────────┘
       │              │
       ▼              ▼
┌─────────────┐ ┌───────────┐
│ KeyManager  │ │  Config   │
│ (crypto.py) │ │(config.py)│
│             │ │           │
│ PBKDF2 +    │ │ YAML/ENV  │
│ Fernet      │ │ loading   │
└─────────────┘ └───────────┘
```

### Module Responsibilities

| Module | Purpose | Key Classes |
|--------|---------|-------------|
| `bot.py` | Main trading interface | `TradingBot`, `OrderResult` |
| `client.py` | API communication | `ClobClient`, `RelayerClient` |
| `signer.py` | EIP-712 signing | `OrderSigner`, `Order` |
| `crypto.py` | Key encryption | `KeyManager` |
| `config.py` | Configuration | `Config`, `BuilderConfig` |
| `utils.py` | Helper functions | `create_bot_from_env`, `validate_address` |
| `gamma_client.py` | Market discovery | `GammaClient` |
| `fair_value.py` | Trading strategy | `FairValueStrategy`, `FairValueConfig` |

### Data Flow

1. `TradingBot.place_order()` creates an `Order` dataclass
2. `OrderSigner.sign_order()` produces EIP-712 signature
3. `ClobClient.post_order()` submits to CLOB with Builder HMAC auth headers
4. If gasless enabled, `RelayerClient` handles Safe deployment/approvals

### Key Patterns

- **Async methods**: All trading operations (`place_order`, `cancel_order`, `get_trades`) are async
- **Config precedence**: Environment vars > YAML file > defaults
- **Builder HMAC auth**: Timestamp + method + path + body signed with api_secret
- **Signature type 2**: Gnosis Safe signatures for Polymarket

### Configuration

Config loads from `config.yaml` or environment variables:

```python
# From environment
config = Config.from_env()

# From YAML
config = Config.load("config.yaml")

# With env overrides
config = Config.load_with_env("config.yaml")
```

Key fields:
- `safe_address`: Your Polymarket proxy wallet address
- `builder.api_key/api_secret/api_passphrase`: For gasless trading (optional)
- `clob.chain_id`: 137 (Polygon mainnet)

### Dependencies

- `eth-account>=0.13.0`: Uses new `encode_typed_data` API
- `web3>=6.0.0`: Polygon RPC interactions
- `cryptography`: Fernet encryption for private keys
- `pyyaml`: YAML config file support
- `python-dotenv`: .env file loading

### Polymarket API Context

- CLOB API: `https://clob.polymarket.com` — order submission/cancellation
- Relayer API: `https://relayer-v2.polymarket.com` — gasless transactions
- Gamma API: `https://gamma-api.polymarket.com` — market discovery
- Token IDs are ERC-1155 identifiers for market outcomes
- Prices are 0-1 (probability percentages)
- USDC has 6 decimal places

**Important**: The `docs/` directory contains official Polymarket documentation:
- `docs/developers/CLOB/` — CLOB API endpoints, authentication, orders
- `docs/developers/builders/` — Builder Program, Relayer, gasless transactions
- `docs/api-reference/` — REST API endpoint specifications
