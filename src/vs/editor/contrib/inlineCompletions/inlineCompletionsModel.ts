/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancelablePromise, createCancelablePromise, RunOnceScheduler } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import * as strings from 'vs/base/common/strings';
import { IActiveCodeEditor } from 'vs/editor/browser/editorBrowser';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { ITextModel } from 'vs/editor/common/model';
import { InlineCompletion, InlineCompletionContext, InlineCompletions, InlineCompletionsProviderRegistry, InlineCompletionTriggerKind } from 'vs/editor/common/modes';
import { BaseGhostTextWidgetModel, GhostText, GhostTextWidgetModel } from 'vs/editor/contrib/inlineCompletions/ghostTextWidget';
import { EditOperation } from 'vs/editor/common/core/editOperation';

export class InlineCompletionsModel extends Disposable implements GhostTextWidgetModel {
	protected readonly onDidChangeEmitter = new Emitter<void>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	private readonly completionSession = this._register(new MutableDisposable<InlineCompletionsSession>());

	private active: boolean = false;

	constructor(private readonly editor: IActiveCodeEditor) {
		super();

		this._register(this.editor.onDidChangeModelContent((e) => {
			if (this.session && !this.session.isValid) {
				this.hide();
			}
			setTimeout(() => {
				this.startSessionIfTriggered();
			}, 0);
		}));

		this._register(this.editor.onDidChangeCursorPosition((e) => {
			if (this.session && !this.session.isValid) {
				this.hide();
			}
		}));
	}

	private get session(): InlineCompletionsSession | undefined {
		return this.completionSession.value;
	}

	public get ghostText(): GhostText | undefined {
		return this.session?.ghostText;
	}

	public get minReservedLineCount(): number {
		return this.session ? this.session.minReservedLineCount : 0;
	}

	public get expanded(): boolean {
		return this.session ? this.session.expanded : false;
	}

	public setExpanded(expanded: boolean): void {
		this.session?.setExpanded(expanded);
	}

	public setActive(active: boolean) {
		this.active = active;
		if (active) {
			this.session?.scheduleUpdate();
		}
	}

	private startSessionIfTriggered(): void {
		if (this.session && this.session.isValid) {
			return;
		}

		this.startSession();
	}

	public startSession(): void {
		if (this.completionSession.value) {
			return;
		}
		this.completionSession.value = new InlineCompletionsSession(this.editor, this.editor.getPosition(), () => this.active);
		this.completionSession.value.takeOwnership(
			this.completionSession.value.onDidChange(() => {
				this.onDidChangeEmitter.fire();
			})
		);
	}

	public hide(): void {
		this.completionSession.clear();
		this.onDidChangeEmitter.fire();
	}

	public commitCurrentSuggestion(): void {
		if (this.session) {
			this.session.commitCurrentCompletion();
		}
	}
}

interface CachedInlineCompletion {
	inlineCompletion: NormalizedInlineCompletion;
	decorationId: string;
	lastRange: Range;
}

class InlineCompletionsSession extends BaseGhostTextWidgetModel {
	public readonly minReservedLineCount = 0;

	private updatePromise: CancelablePromise<NormalizedInlineCompletions> | undefined = undefined;
	private cachedCompletions: CachedInlineCompletion[] | undefined = undefined;

	private updateSoon = this._register(new RunOnceScheduler(() => this.update(), 50));
	private readonly textModel = this.editor.getModel();

	constructor(editor: IActiveCodeEditor, private readonly triggerPosition: Position, private readonly shouldUpdate: () => boolean) {
		super(editor);
		this._register(toDisposable(() => {
			this.clearGhostTextPromise();
		}));

		this._register(this.editor.onDidChangeModelDecorations(e => {
			if (!this.cachedCompletions) {
				return;
			}

			let hasChanged = false;
			for (const c of this.cachedCompletions) {
				const newRange = this.textModel.getDecorationRange(c.decorationId);
				if (!newRange) {
					onUnexpectedError(new Error('Decoration has no range'));
					continue;
				}
				if (!c.lastRange.equalsRange(newRange)) {
					hasChanged = true;
					c.lastRange = newRange;
				}
			}
			if (hasChanged) {
				this.onDidChangeEmitter.fire();
			}
		}));

		this._register(this.editor.onDidChangeModelContent((e) => {
			this.updateSoon.schedule();
		}));

		this.updateSoon.schedule();
	}

	public get ghostText(): GhostText | undefined {
		const currentCompletion = this.currentCompletion;
		return currentCompletion ? inlineCompletionToGhostText(currentCompletion, this.editor.getModel()) : undefined;
	}

	get currentCompletion(): NormalizedInlineCompletion | undefined {
		if (!this.cachedCompletions) {
			return undefined;
		}
		const completion = this.cachedCompletions[0];
		if (!completion) {
			return undefined;
		}
		return {
			text: completion.inlineCompletion.text,
			range: completion.lastRange
		};
	}

	get isValid(): boolean {
		return this.editor.getPosition().lineNumber === this.triggerPosition.lineNumber;
	}

	public scheduleUpdate(): void {
		this.updateSoon.schedule();
	}

	private update(): void {
		if (!this.shouldUpdate()) {
			return;
		}

		const position = this.editor.getPosition();
		this.clearGhostTextPromise();
		this.updatePromise = createCancelablePromise(token =>
			provideInlineCompletions(position,
				this.editor.getModel(),
				{ triggerKind: InlineCompletionTriggerKind.Automatic },
				token
			)
		);
		this.updatePromise.then((result) => {
			this.cachedCompletions = [];
			const decorationIds = this.editor.deltaDecorations(
				(this.cachedCompletions || []).map(c => c.decorationId),
				(result.items).map(i => ({
					range: i.range,
					options: {},
				}))
			);

			this.cachedCompletions = result.items.map((item, idx) => ({
				decorationId: decorationIds[idx],
				inlineCompletion: item,
				lastRange: item.range
			}));
			this.onDidChangeEmitter.fire();
		}, onUnexpectedError);
	}

	private clearGhostTextPromise(): void {
		if (this.updatePromise) {
			this.updatePromise.cancel();
			this.updatePromise = undefined;
		}
	}

	public takeOwnership(disposable: IDisposable): void {
		this._register(disposable);
	}

	public commitCurrentCompletion(): void {
		const completion = this.currentCompletion;
		if (completion) {
			this.commit(completion);
		}
	}

	public commit(completion: NormalizedInlineCompletion): void {
		this.editor.executeEdits(
			'inlineCompletions.accept',
			[
				EditOperation.replaceMove(completion.range, completion.text)
			]
		);
	}
}

export interface NormalizedInlineCompletion extends InlineCompletion {
	range: Range;
}

export interface NormalizedInlineCompletions extends InlineCompletions<NormalizedInlineCompletion> {
}

export function inlineCompletionToGhostText(inlineCompletion: NormalizedInlineCompletion, textModel: ITextModel): GhostText | undefined {
	const valueToBeReplaced = textModel.getValueInRange(inlineCompletion.range);
	if (!inlineCompletion.text.startsWith(valueToBeReplaced)) {
		return undefined;
	}

	const lines = strings.splitLines(inlineCompletion.text.substr(valueToBeReplaced.length));

	return {
		lines,
		position: inlineCompletion.range.getEndPosition()
	};
}

function getDefaultRange(position: Position, model: ITextModel): Range {
	const word = model.getWordAtPosition(position);
	const maxColumn = model.getLineMaxColumn(position.lineNumber);
	// By default, always replace up until the end of the current line.
	// This default might be subject to change!
	return word
		? new Range(position.lineNumber, word.startColumn, position.lineNumber, maxColumn)
		: Range.fromPositions(position, position.with(undefined, maxColumn));
}

async function provideInlineCompletions(
	position: Position,
	model: ITextModel,
	context: InlineCompletionContext,
	token: CancellationToken = CancellationToken.None
): Promise<NormalizedInlineCompletions> {
	const defaultReplaceRange = getDefaultRange(position, model);

	const providers = InlineCompletionsProviderRegistry.all(model);
	const results = await Promise.all(
		providers.map(provider => provider.provideInlineCompletions(model, position, context, token))
	);

	const items = new Array<NormalizedInlineCompletion>();
	for (const result of results) {
		if (result) {
			items.push(...result.items.map<NormalizedInlineCompletion>(item => ({
				text: item.text,
				range: item.range ? Range.lift(item.range) : defaultReplaceRange
			})));
		}
	}

	return { items };
}
