'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {Store, Action} from '../types';
import type {ActionsObservable} from '../../../commons-node/redux-observable';
import type {HgRepositoryClient} from '../../../nuclide-hg-repository-client';

import * as ActionTypes from './ActionTypes';
import * as Actions from './Actions';
import invariant from 'assert';
import {Observable} from 'rxjs';
import {observableFromSubscribeFunction} from '../../../commons-node/event';
import {
  getDirtyFileChanges,
  getHeadRevision,
  getHeadToForkBaseRevisions,
  getSelectedFileChanges,
} from '../RepositoryStack';

const UPDATE_STATUS_DEBOUNCE_MS = 50;

function observeStatusChanges(repository: HgRepositoryClient): Observable<void> {
  return observableFromSubscribeFunction(
    repository.onDidChangeStatuses.bind(repository),
  )
  .debounceTime(UPDATE_STATUS_DEBOUNCE_MS)
  .startWith();
}

// An added, but not-activated repository would continue to provide dirty file change updates,
// because they are cheap to compute, while needed in the UI.
export function addRepositoryEpic(
  actions: ActionsObservable<Action>,
  store: Store,
): Observable<Action> {
  return actions.ofType(ActionTypes.ADD_REPOSITORY).flatMap(action => {
    invariant(action.type === ActionTypes.ADD_REPOSITORY);
    const {repository} = action.payload;

    return observeStatusChanges(repository)
      .map(() => Actions.updateDirtyFiles(repository, getDirtyFileChanges(repository)))
      .takeUntil(observableFromSubscribeFunction(repository.onDidDestroy.bind(repository)))
      .concat(Observable.of(Actions.removeRepository(repository)));
  });
}

// A repository is considered activated only when the Diff View is open.
// This allows to not bother with loading revision info and changes when not needed.
export function activateRepositoryEpic(
  actions: ActionsObservable<Action>,
  store: Store,
): Observable<Action> {
  return actions.ofType(ActionTypes.ACTIVATE_REPOSITORY).flatMap(action => {
    invariant(action.type === ActionTypes.ACTIVATE_REPOSITORY);
    const {repository} = action.payload;

    const statusChanges = observeStatusChanges(repository);
    const revisionChanges = repository.observeRevisionChanges();
    const revisionStatusChanges = repository.observeRevisionStatusesChanges();

    // TODO(most): Add loading states.
    const selectedFileUpdates = Observable.combineLatest(revisionChanges, statusChanges)
      .map(([revisions]) => revisions)
      .filter(revisions => getHeadRevision(revisions) != null)
      .switchMap(revisions => {
        const {repositoriesStates} = store.getState();
        const repositoryState = repositoriesStates.get(repository);
        invariant(repositoryState != null, 'Cannot activate repository before adding it!');
        return Observable.fromPromise(getSelectedFileChanges(
          repository,
          repositoryState.diffOption,
          revisions,
          repositoryState.selectedCompareId,
        ));
      }).map(revisionFileChanges => Actions.updateSelectedFiles(repository, revisionFileChanges));

    const revisionStateUpdates = Observable.combineLatest(revisionChanges, revisionStatusChanges)
      .filter(([revisions]) => getHeadRevision(revisions) != null)
      .map(([revisions, revisionStatuses]) =>
        Actions.updateHeadToForkBaseRevisionsState(
          repository,
          getHeadToForkBaseRevisions(revisions),
          revisionStatuses,
        ),
      );

    return Observable.merge(
      selectedFileUpdates,
      revisionStateUpdates,
    ).takeUntil(Observable.merge(
      observableFromSubscribeFunction(repository.onDidDestroy.bind(repository)),
      actions.filter(a =>
        a.type === ActionTypes.DEACTIVATE_REPOSITORY &&
          a.payload.repository === repository,
      ),
    ));
  });
}
