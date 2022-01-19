import { Buffer, Neovim } from '@chemzqm/neovim'
import debounce from 'debounce'
import { CancellationToken, CancellationTokenSource, Range, SemanticTokens, SemanticTokensDelta, uinteger } from 'vscode-languageserver-protocol'
import languages from '../../languages'
import { SyncItem } from '../../model/bufferSync'
import { HighlightItem, HighlightItemOption } from '../../types'
import workspace from '../../workspace'
import window from '../../window'
const logger = require('../../util/logger')('semanticTokens-buffer')

const HLGROUP_PREFIX = 'CocSem_'
export const NAMESPACE = 'semanticTokens'

/**
 * Relative highlight
 */
interface RelativeHighlight {
  tokenType: string
  tokenModifiers: string[]
  deltaLine: number
  deltaStartCharacter: number
  length: number
}

export interface SemanticTokensConfig {
  enabled: boolean
}

interface SemanticTokensPreviousResult {
  readonly version: number
  readonly resultId: string | undefined,
  readonly tokens?: uinteger[],
}

export default class SemanticTokensBuffer implements SyncItem {
  private tokenSource: CancellationTokenSource
  private _highlights: HighlightItem[]
  private previousResults: SemanticTokensPreviousResult
  public highlight: Function & { clear(): void }
  constructor(
    private nvim: Neovim,
    public readonly bufnr: number,
    private readonly config: SemanticTokensConfig) {
    this.highlight = debounce(() => {
      this.doHighlight().logError()
    }, global.hasOwnProperty('__TEST__') ? 10 : 500)
    this.highlight()
  }

  public onChange(): void {
    this.cancel()
    this.highlight()
  }

  public async forceHighlight(): Promise<void> {
    this.highlight.clear()
    await this.doHighlight()
  }

  /**
   * Get current highlight items
   */
  public get highlights(): ReadonlyArray<HighlightItem> {
    return this._highlights
  }

  public get enabled(): boolean {
    if (!this.config.enabled) return false
    let doc = workspace.getDocument(this.bufnr)
    if (!doc || !doc.attached) return false
    if (languages.getLegend(doc.textDocument) == null) return false
    return languages.hasProvider('semanticTokens', doc.textDocument)
  }

  public get previousVersion(): number | undefined {
    if (!this.previousResults) return undefined
    return this.previousResults.version
  }

  private get buffer(): Buffer {
    return this.nvim.createBuffer(this.bufnr)
  }

  public checkState(): void {
    if (!this.config.enabled) throw new Error('SemanticTokens highlights disabled by configuration')
    let doc = workspace.getDocument(this.bufnr)
    if (!doc || !doc.attached) throw new Error('Document not attached')
    if (languages.getLegend(doc.textDocument) == null) throw new Error('Legend not exists.')
    if (!languages.hasProvider('semanticTokens', doc.textDocument)) throw new Error('SemanticTokens provider not found, your languageserver may not support it')
  }

  public setState(enabled: boolean): void {
    if (enabled) {
      this.highlight()
    } else {
      this.highlight.clear()
      this.clearHighlight()
    }
  }

  /**
   * Request highlights from provider, return undefined when can't request or request cancelled
   * TODO use range provider as well
   */
  private async requestHighlights(token: CancellationToken, forceFull: boolean): Promise<HighlightItem[] | undefined> {
    let doc = workspace.getDocument(this.bufnr)
    const legend = languages.getLegend(doc.textDocument)
    const hasEditProvider = languages.hasSemanticTokensEdits(doc.textDocument)
    const previousResult = forceFull ? null : this.previousResults
    let result: SemanticTokens | SemanticTokensDelta
    let version = doc.textDocument.version
    if (hasEditProvider && previousResult?.resultId) {
      result = await languages.provideDocumentSemanticTokensEdits(doc.textDocument, previousResult.resultId, token)
    } else {
      result = await languages.provideDocumentSemanticTokens(doc.textDocument, token)
    }
    if (token.isCancellationRequested || !result) return undefined
    let tokens: uinteger[] = []
    if (SemanticTokens.is(result)) {
      tokens = result.data
    } else {
      tokens = previousResult.tokens
      result.edits.forEach(e => {
        if (e.deleteCount > 0) {
          tokens.splice(e.start, e.deleteCount, ...e.data)
        } else {
          tokens.splice(e.start, 0, ...e.data)
        }
      })
    }
    this.previousResults = { resultId: result.resultId, tokens, version }
    const relatives: RelativeHighlight[] = []
    for (let i = 0; i < tokens.length; i += 5) {
      const deltaLine = tokens[i]
      const deltaStartCharacter = tokens[i + 1]
      const length = tokens[i + 2]
      const tokenType = tokens[i + 3]
      const tokenModifiers = legend.tokenModifiers.filter((_, m) => tokens[i + 4] & (1 << m))
      relatives.push({ tokenType: legend.tokenTypes[tokenType], tokenModifiers, deltaLine, deltaStartCharacter, length })
    }

    const res: HighlightItem[] = []
    let currentLine = 0
    let currentCharacter = 0
    for (const {
      tokenType,
      deltaLine,
      deltaStartCharacter,
      length
    } of relatives) {
      const lnum = currentLine + deltaLine
      const startCharacter = deltaLine === 0 ? currentCharacter + deltaStartCharacter : deltaStartCharacter
      const endCharacter = startCharacter + length
      currentLine = lnum
      currentCharacter = startCharacter
      let range = Range.create(lnum, startCharacter, lnum, endCharacter)
      let hlGroup = HLGROUP_PREFIX + tokenType
      let opts: HighlightItemOption = { combine: false }
      if (tokenType === 'variable' || tokenType === 'string') {
        opts.end_incl = true
        opts.start_incl = true
      }
      doc.addHighlights(res, hlGroup, range, opts)
    }
    this._highlights = res
    return res
  }

  private async doHighlight(): Promise<void> {
    if (!this.enabled) return
    this.cancel()
    let tokenSource = this.tokenSource = new CancellationTokenSource()
    const items = await this.requestHighlights(tokenSource.token, false)
    // request cancelled or can't work
    if (!items) return
    let diff = await window.diffHighlights(this.bufnr, NAMESPACE, items)
    this.tokenSource = null
    if (tokenSource.token.isCancellationRequested || !diff) return
    await window.applyDiffHighlights(this.bufnr, NAMESPACE, 99, diff)
  }

  public clearHighlight(): void {
    this.buffer.clearNamespace(NAMESPACE)
  }

  public cancel(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel()
      this.tokenSource.dispose()
      this.tokenSource = null
    }
  }

  public dispose(): void {
    this._highlights = []
    this.highlight.clear()
    this.previousResults = undefined
    this.cancel()
  }
}
