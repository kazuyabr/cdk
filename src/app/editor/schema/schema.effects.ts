import { Injectable } from '@angular/core';
import { Actions, Effect } from '@ngrx/effects';
import { Action, Store } from '@ngrx/store';
import { of } from 'rxjs/observable/of';
import { debounceTime, map, switchMap, tap, withLatestFrom } from 'rxjs/operators';

import { MatSnackBar } from '@angular/material';
import * as fromRoot from '../bedrock.reducers';
import { ElectronService } from '../electron.service';
import {
  IFullInteractiveVersion,
  ProjectActionTypes,
  SetOpenProject,
} from '../project/project.actions';
import { withLatestDirectory } from '../project/project.reducer';
import {
  CopyWorldSchema,
  DeleteSnapshot,
  initialWorld,
  ISnapshot,
  LoadSnapshot,
  SaveSnapshot,
  SchemaActionTypes,
  SchemaMethod,
  SnapshotCreated,
  UpdateWorldSchema,
  UploadWorldSchema,
  workingSnapshoptName,
} from './schema.actions';
import { selectWorld } from './schema.reducer';

/**
 * Effects module for account actions.
 */
@Injectable()
export class SchemaEffects {
  /**
   * Fired to load snapshots when we first open a project.
   */
  @Effect()
  public readonly loadOnProjectOpen = this.actions
    .ofType<SetOpenProject>(ProjectActionTypes.SET_OPEN_PROJECT)
    .pipe(
      switchMap(({ project }) =>
        this.electron.call<ISnapshot[]>(SchemaMethod.ListSnapshots, {
          directory: project.directory,
        }),
      ),
      switchMap(snapshots => {
        let mostRecent = snapshots.find(s => s.name === workingSnapshoptName);
        if (!mostRecent) {
          mostRecent = {
            name: workingSnapshoptName,
            world: initialWorld,
            savedAt: Date.now(),
          };
        }

        return of<Action>(new SnapshotCreated(snapshots), new LoadSnapshot(mostRecent));
      }),
    );

  /**
   * Runs the action to save a snapshot.
   */
  @Effect()
  public readonly saveSnapshot = this.actions
    .ofType<SaveSnapshot>(SchemaActionTypes.SAVE_SNAPSHOT)
    .pipe(
      withLatestDirectory(this.store),
      switchMap(([action, directory]) =>
        this.electron.call<ISnapshot>(SchemaMethod.SaveSnapshot, {
          name: action.name,
          world: action.world,
          directory,
        }),
      ),
      map(snapshot => new SnapshotCreated([snapshot])),
    );

  /**
   * Runs the action to delete a snapshot.
   */
  @Effect({ dispatch: false })
  public readonly deleteSnapshopt = this.actions
    .ofType<DeleteSnapshot>(SchemaActionTypes.DELETE_SNAPSHOT)
    .pipe(
      withLatestDirectory(this.store),
      switchMap(([{ name }, directory]) =>
        this.electron.call<ISnapshot>(SchemaMethod.DeleteSnapshot, { name, directory }),
      ),
    );

  /**
   * Persists changes to the control schema as it changes.
   */
  @Effect()
  public readonly saveUpdatedWorld = this.actions
    .ofType<UpdateWorldSchema>(SchemaActionTypes.UPDATE_WORLD_SCHEMA)
    .pipe(
      debounceTime(500),
      withLatestDirectory(this.store),
      switchMap(([{ world }, directory]) =>
        this.electron.call<ISnapshot>(SchemaMethod.SaveSnapshot, {
          name: workingSnapshoptName,
          directory,
          world,
        }),
      ),
      map(snapshot => new SnapshotCreated([snapshot])),
    );

  /**
   * Downloads the world schema from a remote version.
   */
  @Effect()
  public readonly copyWorldSchema = this.actions
    .ofType<CopyWorldSchema>(SchemaActionTypes.COPY_WORLD_FROM_GAME)
    .pipe(
      withLatestDirectory(this.store),
      switchMap(([{ game }, directory]) =>
        this.electron.call<IFullInteractiveVersion>(SchemaMethod.GetGameVersionDetails, {
          game,
          directory,
        }),
      ),
      map(version => {
        if (Array.isArray(version.controls)) {
          return new UpdateWorldSchema({ scenes: version.controls });
        }

        return new UpdateWorldSchema(version.controls);
      }),
      tap(() => this.snacks.open('Control Schema Updated', undefined, { duration: 1000 })),
    );

  /**
   * Uploads the world schema to the given version
   */
  @Effect({ dispatch: false })
  public readonly uploadWorldSchema = this.actions
    .ofType<UploadWorldSchema>(SchemaActionTypes.UPLOAD_WORLD_TO_GAME)
    .pipe(
      withLatestFrom(this.store.select(selectWorld)),
      withLatestDirectory(this.store),
      switchMap(([[{ game }, world], directory]) =>
        this.electron.call<IFullInteractiveVersion>(SchemaMethod.SetGameSchema, {
          game,
          directory,
          world,
        }),
      ),
      tap(() => this.snacks.open('Control Schema Uploaded', undefined, { duration: 1000 })),
    );

  constructor(
    private readonly actions: Actions,
    private readonly store: Store<fromRoot.IState>,
    private readonly electron: ElectronService,
    private readonly snacks: MatSnackBar,
  ) {}
}
