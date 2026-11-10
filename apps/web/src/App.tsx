import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  LockKeyhole,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Wallet,
  X,
  Zap,
} from 'lucide-react'
import { NearConnector } from '@hot-labs/near-connect'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

const nearConnector = new NearConnector({
  network: 'testnet',
  features: {
    testnet: true,
  },
})

type WalletConnection = {
  accountId: string
  walletName: string
}

type NearAccountSnapshot = {
  success: boolean
  network: string
  accountId: string
  balanceYocto: string
  balanceNear: string
  lockedYocto: string
  storageUsage: number | null
  blockHeight: number
  blockHash: string
  finality: string
  verifiedAt: string
  source: string
}
type Health = {
  success: boolean
  service: string
  status: string
  database: string
  executionMode: string
  timestamp: string
}

type Transfer = {
  id: number
  amount: number
  currency: string
  recipient: string
  policy_decision: string
  reason_code: string
  status: string
  approval_id: number | null
  created_at: string
}

type Approval = {
  id: number
  transfer_id: number | null
  amount: number
  currency: string
  recipient: string
  reason_code: string
  status: string
  reviewer: string | null
  created_at: string
  reviewed_at: string | null
}

type Execution = {
  id: number
  transfer_id: number
  amount: number
  currency: string
  recipient: string
  execution_status: string
  created_at: string
}

type AuditEvent = {
  id: number
  event_type: string
  details: string
  created_at: string
}

class ApiAuthError extends Error {
  constructor() {
    super('WARDEN authentication is required or the session has expired.')
    this.name = 'ApiAuthError'
  }
}

async function apiRequest<T>(
  path: string,
  tokenOrOptions?: string | RequestInit,
  requestOptions?: RequestInit,
): Promise<T> {
  const token = typeof tokenOrOptions === 'string' ? tokenOrOptions : ''
  const options = typeof tokenOrOptions === 'string' ? requestOptions : tokenOrOptions

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  const data = await response.json()

  if (response.status === 401) {
    throw new ApiAuthError()
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed (${response.status})`)
  }

  return data as T
}

function money(amount: number, currency = 'NEAR') {
  return `${Number(amount).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })} ${currency}`
}

function dateLabel(value: string) {
  if (!value) return '—'
  const date = new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z'))
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function StatusPill({ value }: { value: string }) {
  const normalized = value.toUpperCase()
  let className = 'status-neutral'

  if (
    ['ALLOW', 'APPROVED', 'AUTHORIZED', 'SIMULATED_EXECUTED', 'SIMULATED'].includes(normalized)
  ) className = 'status-good'

  if (['REQUIRES_APPROVAL', 'AWAITING_APPROVAL', 'PENDING'].includes(normalized))
    className = 'status-warning'

  if (['BLOCK', 'BLOCKED', 'REJECTED', 'FAILED'].includes(normalized))
    className = 'status-danger'

  return <span className={`status-pill ${className}`}>{value.replaceAll('_', ' ')}</span>
}

function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [executions, setExecutions] = useState<Execution[]>([])
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [busyApproval, setBusyApproval] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [walletConnection, setWalletConnection] = useState<WalletConnection | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [walletError, setWalletError] = useState('')
  const [testnetWalletCount, setTestnetWalletCount] = useState(0)
  const [nearAccountSnapshot, setNearAccountSnapshot] = useState<NearAccountSnapshot | null>(null)
  const [nearRpcError, setNearRpcError] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')
  const [proposalAmount, setProposalAmount] = useState('')
  const [proposalRecipient, setProposalRecipient] = useState('')
  const [proposalBusy, setProposalBusy] = useState(false)

  const nearRpcBusy = Boolean(apiToken && walletConnection?.accountId && !nearAccountSnapshot && !nearRpcError)

  const clearAuthenticatedSession = useCallback((message: string) => {
    setApiToken('')
    setTokenInput('')
    setTransfers([])
    setApprovals([])
    setExecutions([])
    setEvents([])
    setHealth(null)
    setError('')
    setNotice('')
    setNearAccountSnapshot(null)
    setNearRpcError('')
    setAuthError(message)
  }, [])

  async function authenticateApi() {
    const candidate = tokenInput.trim()

    if (!candidate) {
      setAuthError('Enter your WARDEN API token.')
      return
    }

    setAuthBusy(true)
    setAuthError('')

    try {
      await apiRequest<{ transfers: Transfer[] }>('/api/transfers', candidate)
      setApiToken(candidate)
      setTokenInput('')
      setError('')
    } catch (err) {
      setAuthError(
        err instanceof ApiAuthError
          ? 'The API token is invalid. Check it and try again.'
          : err instanceof Error
            ? err.message
            : 'Unable to authenticate with the WARDEN API.',
      )
    } finally {
      setAuthBusy(false)
    }
  }


  const loadDashboardData = useCallback(async () => {
    const [healthData, transferData, approvalData, executionData, auditData] =
      await Promise.all([
        apiRequest<Health>('/api/health'),
        apiRequest<{ transfers: Transfer[] }>('/api/transfers', apiToken),
        apiRequest<{ approvals: Approval[] }>('/api/approvals', apiToken),
        apiRequest<{ executions: Execution[] }>('/api/executions', apiToken),
        apiRequest<{ events: AuditEvent[] }>('/api/audit', apiToken),
      ])

    return {
      healthData,
      transferData,
      approvalData,
      executionData,
      auditData,
    }
  }, [apiToken])

  const applyDashboardData = useCallback(
    (data: Awaited<ReturnType<typeof loadDashboardData>>) => {
      setHealth(data.healthData)
      setTransfers(data.transferData.transfers || [])
      setApprovals(data.approvalData.approvals || [])
      setExecutions(data.executionData.executions || [])
      setEvents(data.auditData.events || [])
      setError('')
    },
    [],
  )

  const refresh = useCallback(async () => {
    try {
      const data = await loadDashboardData()
      applyDashboardData(data)
    } catch (err) {
      if (err instanceof ApiAuthError) {
        clearAuthenticatedSession('Your WARDEN API session expired. Sign in again.')
      } else {
        setError(err instanceof Error ? err.message : 'Unable to connect to WARDEN API')
      }
    }
  }, [loadDashboardData, applyDashboardData, clearAuthenticatedSession])

  async function refreshManually() {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    if (!apiToken) {
      return
    }

    let active = true

    const load = () => {
      void loadDashboardData()
        .then((data) => {
          if (active) applyDashboardData(data)
        })
        .catch((err: unknown) => {
          if (active) {
            if (err instanceof ApiAuthError) {
              clearAuthenticatedSession('Your WARDEN API session expired. Sign in again.')
            } else {
              setError(err instanceof Error ? err.message : 'Unable to connect to WARDEN API')
            }
          }
        })
    }

    load()
    const interval = window.setInterval(load, 15000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [apiToken, loadDashboardData, applyDashboardData, clearAuthenticatedSession])

  useEffect(() => {
    const handleSignIn = (payload: {
      accounts: Array<{ accountId: string }>
      wallet: { manifest: { name: string; features: { testnet: boolean } } }
      success: boolean
    }) => {
      if (!payload.success || !payload.accounts[0]) {
        setWalletError('Wallet connection did not return an account.')
        return
      }

      if (!payload.wallet.manifest.features.testnet) {
        setWalletConnection(null)
        setWalletError('This wallet does not advertise NEAR Testnet support.')
        return
      }

      setWalletConnection({
        accountId: payload.accounts[0].accountId,
        walletName: payload.wallet.manifest.name,
      })
      setNearAccountSnapshot(null)
      setNearRpcError('')
      setWalletError('')
    }

    const handleSignOut = () => {
      setWalletConnection(null)
      setNearAccountSnapshot(null)
      setNearRpcError('')

      setWalletError('')
    }

    nearConnector.on('wallet:signIn', handleSignIn)
    nearConnector.on('wallet:signOut', handleSignOut)

    void nearConnector.whenManifestLoaded
      .then(() => {
        const compatibleWallets = nearConnector.availableWallets.filter(
          (wallet) => wallet.manifest.features.testnet,
        )
        setTestnetWalletCount(compatibleWallets.length)
      })
      .catch((err: unknown) => {
        setWalletError(
          err instanceof Error ? err.message : 'Unable to load NEAR wallet list.',
        )
      })

    return () => {
      nearConnector.off('wallet:signIn', handleSignIn)
      nearConnector.off('wallet:signOut', handleSignOut)
    }
  }, [])

  useEffect(() => {
    const accountId = walletConnection?.accountId

    if (!apiToken || !accountId) {
      return
    }

    let cancelled = false

    const verify = async () => {
      try {
        const snapshot = await apiRequest<NearAccountSnapshot>(
          `/api/near/account/${encodeURIComponent(accountId)}`,
          apiToken,
        )

        if (cancelled) return

        if (
          !snapshot.success ||
          snapshot.accountId !== accountId ||
          snapshot.network !== 'testnet'
        ) {
          throw new Error('The RPC response did not match the connected Testnet account.')
        }

        setNearAccountSnapshot(snapshot)
      } catch (err) {
        if (cancelled) return

        if (err instanceof ApiAuthError) {
          clearAuthenticatedSession('Your WARDEN API session expired. Sign in again.')
        } else {
          setNearRpcError(
            err instanceof Error ? err.message : 'Unable to verify NEAR Testnet account.',
          )
        }
      }
    }

    void verify()

    return () => {
      cancelled = true
    }
  }, [apiToken, walletConnection?.accountId, clearAuthenticatedSession])

  const pendingApprovals = useMemo(
    () => approvals.filter((item) => item.status === 'PENDING'),
    [approvals],
  )

  const actionableApprovals = pendingApprovals.filter(
    (item) => item.transfer_id !== null,
  )

  const blockedCount = transfers.filter((item) => item.status === 'BLOCKED').length
  const simulatedCount = executions.length

  async function decideApproval(id: number, decision: 'APPROVE' | 'REJECT') {
    setBusyApproval(id)
    setNotice('')
    setError('')

    try {
      await apiRequest(
        `/api/approvals/${id}/decision`,
        apiToken,
        {
          method: 'POST',
          body: JSON.stringify({ decision }),
        },
      )

      setNotice(`Approval #${id} ${decision === 'APPROVE' ? 'approved' : 'rejected'}. No transfer was executed.`)
      await refreshManually()
    } catch (err) {
      if (err instanceof ApiAuthError) {
        clearAuthenticatedSession('Your WARDEN API session expired. Sign in again.')
      } else {
        setError(err instanceof Error ? err.message : 'Approval decision failed')
      }
    } finally {
      setBusyApproval(null)
    }
  }

  async function submitTransferProposal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const amount = proposalAmount.trim()
    const recipient = proposalRecipient.trim().toLowerCase()

    if (!amount || !recipient || !/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      setError('Enter a valid positive NEAR amount and recipient account.')
      return
    }

    setProposalBusy(true)
    setError('')
    setNotice('')

    try {
      const result = await apiRequest<{
        success: boolean
        transferId: number
        approvalId: number | null
        policy: {
          decision: string
          reasonCode: string
        }
        transferStatus: string
      }>('/api/policy/evaluate', apiToken, {
        method: 'POST',
        body: JSON.stringify({
          amount,
          currency: 'NEAR',
          recipient,
        }),
      })

      const approvalMessage = result.approvalId
        ? ` Approval #${result.approvalId} was created for review.`
        : ''

      setNotice(
        `Transfer #${result.transferId}: ${result.policy.decision.replaceAll('_', ' ')} (${result.policy.reasonCode}).${approvalMessage} No funds were moved.`,
      )
      setProposalAmount('')
      await refreshManually()
    } catch (err) {
      if (err instanceof ApiAuthError) {
        clearAuthenticatedSession('Your WARDEN API session expired. Sign in again.')
      } else {
        setError(err instanceof Error ? err.message : 'Transfer proposal failed.')
      }
    } finally {
      setProposalBusy(false)
    }
  }

  async function connectNearWallet() {
    setWalletBusy(true)
    setWalletError('')

    try {
      await nearConnector.whenManifestLoaded

      const compatibleWallets = nearConnector.availableWallets.filter(
        (wallet) => wallet.manifest.features.testnet,
      )

      if (compatibleWallets.length === 0) {
        throw new Error('No available wallet currently advertises NEAR Testnet support.')
      }

      await nearConnector.connect()

      const connected = await nearConnector.getConnectedWallet()
      const account = connected.accounts[0]

      if (!account) {
        throw new Error('The wallet connected but did not return an account.')
      }

      if (!connected.wallet.manifest.features.testnet) {
        await nearConnector.disconnect(connected.wallet)
        throw new Error('The selected wallet does not advertise Testnet support.')
      }

      setWalletConnection({
        accountId: account.accountId,
        walletName: connected.wallet.manifest.name,
      })
    } catch (err) {
      setWalletError(
        err instanceof Error ? err.message : 'Unable to connect NEAR wallet.',
      )
    } finally {
      setWalletBusy(false)
    }
  }

  async function disconnectNearWallet() {
    setWalletBusy(true)
    setWalletError('')

    try {
      const connected = await nearConnector.getConnectedWallet()
      await nearConnector.disconnect(connected.wallet)
      setWalletConnection(null)
    } catch (err) {
      setWalletError(
        err instanceof Error ? err.message : 'Unable to disconnect NEAR wallet.',
      )
    } finally {
      setWalletBusy(false)
    }
  }
  if (!apiToken) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="auth-brand">
            <div className="auth-brand-mark"><Shield size={25} /></div>
            <div>
              <div className="auth-brand-name">WARDEN</div>
              <div className="auth-brand-caption">AUTONOMOUS TREASURY SECURITY</div>
            </div>
          </div>

          <div className="auth-eyebrow">SECURE OPERATOR ACCESS</div>
          <h1>Sign in to WARDEN</h1>
          <p className="auth-description">
            Enter the API access token configured by your WARDEN administrator
            to open the treasury control centre.
          </p>

          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault()
              void authenticateApi()
            }}
          >
            <label htmlFor="warden-api-token">API access token</label>
            <input
              id="warden-api-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="Enter your WARDEN API token"
              required
              disabled={authBusy}
            />

            {authError && (
              <div className="auth-error" role="alert">
                <ShieldAlert size={16} />
                <span>{authError}</span>
              </div>
            )}

            <button className="auth-submit" type="submit" disabled={authBusy}>
              {authBusy ? 'Verifying access…' : 'Access control centre'}
            </button>
          </form>

          <div className="auth-security-note">
            <LockKeyhole size={15} />
            <span>Your token is held in memory only and is not saved in browser storage.</span>
          </div>

          <div className="auth-mode-note">
            WARDEN MVP · TEST ENVIRONMENT · SIMULATION ONLY
          </div>
        </section>
      </main>
    )
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Shield size={23} /></div>
          <div>
            <div className="brand-name">WARDEN</div>
            <div className="brand-caption">AUTONOMOUS TREASURY SECURITY</div>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">
          <a className="nav-link active" href="#overview"><Activity size={17} /> Overview</a>
          <a className="nav-link" href="#transfers"><Wallet size={17} /> Transfers</a>
          <a className="nav-link" href="#approvals">
            <CheckCircle2 size={17} /> Approvals
            {actionableApprovals.length > 0 && <span className="nav-count">{actionableApprovals.length}</span>}
          </a>
          <a className="nav-link" href="#audit"><FileText size={17} /> Audit trail</a>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-security">
            <div className="security-icon"><LockKeyhole size={16} /></div>
            <div>
              <strong>Policy protection active</strong>
              <span>Deterministic controls enabled</span>
            </div>
          </div>
          <div className="sidebar-version">WARDEN MVP · TEST ENVIRONMENT</div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Overview</div>
          <div className="topbar-actions">
            <div className="environment-tag"><span className="pulse-dot" /> TESTNET PREPARATION</div>
            <div className={`wallet-connection ${walletConnection ? 'connected' : ''}`}>
              <div className="wallet-identity">
                <span className="wallet-status-dot" />
                <div className="wallet-identity-copy">
                  <strong>
                    {walletConnection
                      ? walletConnection.accountId
                      : 'NEAR wallet'}
                  </strong>
                  <span>
                    {walletConnection
                      ? walletConnection.walletName + ' · TESTNET'
                      : testnetWalletCount + ' Testnet-compatible wallets'}
                  </span>
                  {walletConnection && (
                    <span className="near-rpc-status">
                      {nearRpcBusy
                        ? 'Checking finalized RPC balance…'
                        : nearAccountSnapshot
                          ? `RPC verified · ${Number(nearAccountSnapshot.balanceNear).toLocaleString(undefined, { maximumFractionDigits: 6 })} NEAR · Block ${nearAccountSnapshot.blockHeight.toLocaleString()}`
                          : nearRpcError
                            ? `RPC verification failed · ${nearRpcError}`
                            : 'RPC balance not yet verified'}
                    </span>
                  )}
                </div>
              </div>

              {walletConnection ? (
                <button
                  className="wallet-button wallet-disconnect"
                  onClick={() => void disconnectNearWallet()}
                  disabled={walletBusy}
                >
                  {walletBusy ? 'Disconnecting…' : 'Disconnect'}
                </button>
              ) : (
                <button
                  className="wallet-button"
                  onClick={() => void connectNearWallet()}
                  disabled={walletBusy || testnetWalletCount === 0}
                  title={
                    testnetWalletCount === 0
                      ? 'Waiting for compatible Testnet wallets'
                      : 'Connect a NEAR Testnet wallet'
                  }
                >
                  <Wallet size={14} />
                  {walletBusy ? 'Connecting…' : 'Connect wallet'}
                </button>
              )}
            </div>

            <button className="icon-button" title="Notifications" aria-label="Notifications">
              <Bell size={18} />
            </button>
            <div className="avatar">W</div>
            <button
              className="auth-logout"
              type="button"
              onClick={() => clearAuthenticatedSession('You have signed out of WARDEN.')}
              title="Sign out of WARDEN"
            >
              <LockKeyhole size={14} />
              Sign out
            </button>
          </div>
        </header>

        <div className="page-content" id="overview">
          <section className="page-heading">
            <div>
              <div className="eyebrow">TREASURY INTELLIGENCE &amp; DECISION TRACE</div>
              <h1>Control Centre</h1>
              <p>Monitor agent proposals, enforce policy boundaries, and review every decision.</p>
            </div>
            <button className="refresh-button" onClick={() => void refreshManually()} disabled={refreshing}>
              <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
              {refreshing ? 'Refreshing' : 'Refresh data'}
            </button>
          </section>

          {walletError && (
            <div className="alert alert-error wallet-error" role="alert">
              <span>NEAR wallet: {walletError}</span>
              <button onClick={() => setWalletError('')}>Dismiss</button>
            </div>
          )}

          {error && (
            <div className="alert alert-error">
              <ShieldAlert size={18} />
              <div><strong>API connection issue</strong><span>{error}. Check that the WARDEN API is running on port 3001.</span></div>
              <button onClick={() => void refreshManually()}>Retry</button>
            </div>
          )}

          {notice && (
            <div className="alert alert-success">
              <CheckCircle2 size={18} />
              <span>{notice}</span>
              <button onClick={() => setNotice('')} aria-label="Dismiss notice"><X size={16} /></button>
            </div>
          )}

          <section className="system-banner">
            <div className="system-main">
              <div className="system-icon"><ShieldCheck size={21} /></div>
              <div>
                <strong>WARDEN protection layer</strong>
                <span>Policy engine, approval gate and audit logging</span>
              </div>
            </div>
            <div className="system-indicators">
              <span><i className={health?.status === 'operational' ? 'indicator online' : 'indicator'} /> API {health?.status || 'checking'}</span>
              <span><i className={health?.database === 'connected' ? 'indicator online' : 'indicator'} /> Database {health?.database || 'checking'}</span>
              <span className="simulation-label"><LockKeyhole size={13} /> SIMULATION ONLY</span>
            </div>
          </section>

          <section className="metrics-grid">
            <MetricCard icon={<Wallet size={18} />} label="Transfer records" value={transfers.length} detail="Persisted requests" />
            <MetricCard icon={<Clock3 size={18} />} label="Pending approvals" value={actionableApprovals.length} detail={`${pendingApprovals.length - actionableApprovals.length} legacy unlinked`} tone="warning" />
            <MetricCard icon={<ShieldAlert size={18} />} label="Policy blocked" value={blockedCount} detail="Hard-limit or policy rejection" tone="danger" />
            <MetricCard icon={<Zap size={18} />} label="Simulated executions" value={simulatedCount} detail="No real funds moved" tone="success" />
          </section>

          <section className="content-grid">
            <div className="panel policy-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">DECISION FRAMEWORK</div>
                  <h2>Policy engine</h2>
                </div>
                <span className="live-tag"><span className="pulse-dot" /> ACTIVE</span>
              </div>
              <div className="policy-list">
                <div className="policy-row">
                  <div className="policy-symbol allow"><Check size={17} /></div>
                  <div className="policy-copy"><strong>ALLOW</strong><span>Within autonomous limits</span></div>
                  <StatusPill value="ALLOW" />
                </div>
                <div className="policy-row">
                  <div className="policy-symbol review"><Clock3 size={17} /></div>
                  <div className="policy-copy"><strong>REQUIRES APPROVAL</strong><span>Human review required</span></div>
                  <StatusPill value="REQUIRES_APPROVAL" />
                </div>
                <div className="policy-row">
                  <div className="policy-symbol block"><X size={17} /></div>
                  <div className="policy-copy"><strong>BLOCK</strong><span>Hard policy boundary exceeded</span></div>
                  <StatusPill value="BLOCK" />
                </div>
              </div>
              <div className="limits-box">
                <div className="limits-title">CURRENT DEMO LIMITS</div>
                <div><span>Autonomous transfer ceiling</span><strong>0.01 NEAR</strong></div>
                <div><span>Hard transfer limit</span><strong>1 NEAR</strong></div>
                <p>Demo configuration only. Not production risk settings.</p>
              </div>
            </div>

            <div className="panel execution-panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">EXECUTION SAFETY</div>
                  <h2>Execution gate</h2>
                </div>
                <div className="gate-icon"><LockKeyhole size={20} /></div>
              </div>
              <div className="gate-status">
                <div className="gate-check"><ShieldCheck size={27} /></div>
                <div><strong>Simulation mode enabled</strong><span>Real transaction submission is disabled.</span></div>
              </div>
              <div className="gate-rules">
                <div><CheckCircle2 size={15} /><span>Policy decision checked before execution</span></div>
                <div><CheckCircle2 size={15} /><span>Matching approval required when applicable</span></div>
                <div><CheckCircle2 size={15} /><span>Duplicate simulation attempts rejected</span></div>
                <div><CheckCircle2 size={15} /><span>Execution events persisted to audit log</span></div>
              </div>
              <div className="gate-footer"><Database size={14} /> SQLite persistence · Local API</div>
            </div>
          </section>

          <section className="panel proposal-panel" id="new-transfer">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">POLICY-GATED REQUEST</div>
                <h2>Create transfer proposal</h2>
              </div>
              <span className="count-tag">NEAR TESTNET</span>
            </div>

            <p className="proposal-description">
              Submit a transfer request for WARDEN policy evaluation. Recipient
              verification and approval requirements are checked by the backend.
              This form does not sign or execute blockchain transactions.
            </p>

            <form className="proposal-form" onSubmit={(event) => void submitTransferProposal(event)}>
              <div className="proposal-fields">
                <label>
                  Amount (NEAR)
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="e.g. 0.005"
                    value={proposalAmount}
                    onChange={(event) => setProposalAmount(event.target.value)}
                    maxLength={50}
                    required
                    disabled={proposalBusy}
                  />
                </label>

                <label>
                  Recipient Testnet account
                  <input
                    type="text"
                    placeholder="recipient.testnet"
                    value={proposalRecipient}
                    onChange={(event) => setProposalRecipient(event.target.value)}
                    maxLength={64}
                    autoComplete="off"
                    required
                    disabled={proposalBusy}
                  />
                </label>
              </div>

              <div className="proposal-footer">
                <span>Policy limits: 0.01 NEAR autonomous · 1 NEAR hard limit</span>
                <button className="auth-submit proposal-submit" type="submit" disabled={proposalBusy}>
                  {proposalBusy ? 'Evaluating proposal…' : 'Evaluate transfer proposal'}
                </button>
              </div>
            </form>
          </section>

          <section className="panel" id="approvals">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">HUMAN-IN-THE-LOOP</div>
                <h2>Approval queue</h2>
              </div>
              <span className="count-tag">{actionableApprovals.length} actionable</span>
            </div>

            {actionableApprovals.length === 0 ? (
              <EmptyState text="No linked approvals are waiting for review." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>TRANSFER</th><th>AMOUNT</th><th>RECIPIENT</th><th>REASON</th><th>CREATED</th><th>ACTION</th></tr></thead>
                  <tbody>
                    {actionableApprovals.map((approval) => (
                      <tr key={approval.id}>
                        <td><strong>#{approval.transfer_id}</strong><small>Approval #{approval.id}</small></td>
                        <td className="amount-cell">{money(approval.amount, approval.currency)}</td>
                        <td>{approval.recipient}</td>
                        <td><span className="reason-code">{approval.reason_code}</span></td>
                        <td className="muted-cell">{dateLabel(approval.created_at)}</td>
                        <td>
                          <div className="action-buttons">
                            <button className="approve-button" disabled={busyApproval === approval.id} onClick={() => void decideApproval(approval.id, 'APPROVE')}>
                              <Check size={14} /> Approve
                            </button>
                            <button className="reject-button" disabled={busyApproval === approval.id} onClick={() => void decideApproval(approval.id, 'REJECT')}>
                              <X size={14} /> Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="demo-reviewer-note">Approval decisions are recorded under the server-configured reviewer identity.</p>
          </section>

          <section className="panel" id="transfers">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">AGENT ACTIVITY</div>
                <h2>Transfer history</h2>
              </div>
              <span className="count-tag">{transfers.length} records</span>
            </div>
            {transfers.length === 0 ? (
              <EmptyState text="No transfer requests have been recorded yet." />
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>TRANSFER ID</th><th>AMOUNT</th><th>RECIPIENT</th><th>POLICY DECISION</th><th>STATUS</th><th>APPROVAL</th></tr></thead>
                  <tbody>
                    {transfers.map((transfer) => (
                      <tr key={transfer.id}>
                        <td><strong>#{transfer.id}</strong></td>
                        <td className="amount-cell">{money(transfer.amount, transfer.currency)}</td>
                        <td>{transfer.recipient || '—'}</td>
                        <td><StatusPill value={transfer.policy_decision} /></td>
                        <td><StatusPill value={transfer.status} /></td>
                        <td>{transfer.approval_id ? `#${transfer.approval_id}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="bottom-grid">
            <div className="panel" id="audit">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">PERSISTENT DECISION TRACE</div>
                  <h2>Recent audit events</h2>
                </div>
                <FileText size={18} className="muted-icon" />
              </div>
              <div className="audit-list">
                {events.slice(0, 7).map((event) => (
                  <div className="audit-item" key={event.id}>
                    <div className={`audit-dot ${event.event_type === 'SIMULATED_EXECUTION' ? 'audit-green' : event.event_type === 'APPROVAL_DECIDED' ? 'audit-purple' : ''}`} />
                    <div className="audit-content">
                      <strong>{event.event_type.replaceAll('_', ' ')}</strong>
                      <span>{event.details}</span>
                      <small>{dateLabel(event.created_at)}</small>
                    </div>
                    <span className="audit-id">#{event.id}</span>
                  </div>
                ))}
                {events.length === 0 && <EmptyState text="Audit events will appear here." />}
              </div>
            </div>

            <div className="panel">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">EXECUTION RECORDS</div>
                  <h2>Simulated activity</h2>
                </div>
                <Activity size={18} className="muted-icon" />
              </div>
              <div className="execution-list">
                {executions.map((execution) => (
                  <div className="execution-item" key={execution.id}>
                    <div className="execution-icon"><ArrowUpRight size={17} /></div>
                    <div className="execution-copy">
                      <strong>{money(execution.amount, execution.currency)}</strong>
                      <span>To {execution.recipient} · Transfer #{execution.transfer_id}</span>
                      <small>{dateLabel(execution.created_at)}</small>
                    </div>
                    <StatusPill value={execution.execution_status} />
                  </div>
                ))}
                {executions.length === 0 && <EmptyState text="No simulated executions yet." />}
              </div>
              <div className="execution-disclaimer">
                <LockKeyhole size={14} />
                These are local simulations, not blockchain transactions.
              </div>
            </div>
          </section>

          <footer className="page-footer">
            <span>WARDEN · Give agents authority. Keep control.</span>
            <span>API {health?.status || 'unavailable'} · {health?.executionMode || 'MODE UNKNOWN'}</span>
          </footer>
        </div>
      </main>
    </div>
  )
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  tone = 'default',
}: {
  icon: React.ReactNode
  label: string
  value: number
  detail: string
  tone?: string
}) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}>{icon}</div>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><ArrowDownRight size={18} /><span>{text}</span></div>
}

export default App
