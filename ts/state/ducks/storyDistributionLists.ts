// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { omit } from 'lodash';
import type { ThunkAction } from 'redux-thunk';

import type { ReadonlyDeep } from 'type-fest';
import type { StateType as RootStateType } from '../reducer';
import type { StoryDistributionWithMembersType } from '../../sql/Interface';
import type { UUIDStringType } from '../../types/UUID';
import * as log from '../../logging/log';
import dataInterface from '../../sql/Client';
import { MY_STORY_ID } from '../../types/Stories';
import { UUID } from '../../types/UUID';
import { deleteStoryForEveryone } from '../../util/deleteStoryForEveryone';
import { replaceIndex } from '../../util/replaceIndex';
import { storageServiceUploadJob } from '../../services/storage';
import type { BoundActionCreatorsMapObject } from '../../hooks/useBoundActions';
import { useBoundActions } from '../../hooks/useBoundActions';

// State

export type StoryDistributionListDataType = ReadonlyDeep<{
  id: UUIDStringType;
  deletedAtTimestamp?: number;
  name: string;
  allowsReplies: boolean;
  isBlockList: boolean;
  memberUuids: Array<UUIDStringType>;
}>;

export type StoryDistributionListStateType = ReadonlyDeep<{
  distributionLists: Array<StoryDistributionListDataType>;
}>;

// Actions

const ALLOW_REPLIES_CHANGED = 'storyDistributionLists/ALLOW_REPLIES_CHANGED';
const CREATE_LIST = 'storyDistributionLists/CREATE_LIST';
export const DELETE_LIST = 'storyDistributionLists/DELETE_LIST';
export const HIDE_MY_STORIES_FROM =
  'storyDistributionLists/HIDE_MY_STORIES_FROM';
export const MODIFY_LIST = 'storyDistributionLists/MODIFY_LIST';
const RESET_MY_STORIES = 'storyDistributionLists/RESET_MY_STORIES';
export const VIEWERS_CHANGED = 'storyDistributionLists/VIEWERS_CHANGED';

type AllowRepliesChangedActionType = ReadonlyDeep<{
  type: typeof ALLOW_REPLIES_CHANGED;
  payload: {
    listId: string;
    allowsReplies: boolean;
  };
}>;

type CreateListActionType = ReadonlyDeep<{
  type: typeof CREATE_LIST;
  payload: StoryDistributionListDataType;
}>;

type DeleteListActionType = ReadonlyDeep<{
  type: typeof DELETE_LIST;
  payload: {
    listId: string;
    deletedAtTimestamp: number;
  };
}>;

type HideMyStoriesFromActionType = ReadonlyDeep<{
  type: typeof HIDE_MY_STORIES_FROM;
  payload: Array<UUIDStringType>;
}>;

type ModifyDistributionListType = ReadonlyDeep<
  Omit<StoryDistributionListDataType, 'memberUuids'> & {
    membersToAdd: Array<UUIDStringType>;
    membersToRemove: Array<UUIDStringType>;
  }
>;

export type ModifyListActionType = ReadonlyDeep<{
  type: typeof MODIFY_LIST;
  payload: ModifyDistributionListType;
}>;

type ResetMyStoriesActionType = ReadonlyDeep<{
  type: typeof RESET_MY_STORIES;
}>;

type ViewersChangedActionType = ReadonlyDeep<{
  type: typeof VIEWERS_CHANGED;
  payload: {
    listId: string;
    memberUuids: Array<UUIDStringType>;
  };
}>;

export type StoryDistributionListsActionType = ReadonlyDeep<
  | AllowRepliesChangedActionType
  | CreateListActionType
  | DeleteListActionType
  | HideMyStoriesFromActionType
  | ModifyListActionType
  | ResetMyStoriesActionType
  | ViewersChangedActionType
>;

// Action Creators

function allowsRepliesChanged(
  listId: string,
  allowsReplies: boolean
): ThunkAction<void, RootStateType, null, AllowRepliesChangedActionType> {
  return async dispatch => {
    const storyDistribution =
      await dataInterface.getStoryDistributionWithMembers(listId);

    if (!storyDistribution) {
      log.warn(
        'storyDistributionLists.allowsRepliesChanged: No story found for id',
        listId
      );
      return;
    }

    if (storyDistribution.allowsReplies === allowsReplies) {
      log.warn(
        'storyDistributionLists.allowsRepliesChanged: story already has the same value',
        { listId, allowsReplies }
      );
      return;
    }

    await dataInterface.modifyStoryDistribution({
      ...storyDistribution,
      allowsReplies,
      storageNeedsSync: true,
    });

    storageServiceUploadJob();

    log.info(
      'storyDistributionLists.allowsRepliesChanged: allowsReplies has changed',
      listId
    );

    dispatch({
      type: ALLOW_REPLIES_CHANGED,
      payload: {
        listId,
        allowsReplies,
      },
    });
  };
}

function createDistributionList(
  name: string,
  memberUuids: Array<UUIDStringType>,
  storageServiceDistributionListRecord?: StoryDistributionWithMembersType,
  shouldSave = true
): ThunkAction<
  Promise<UUIDStringType>,
  RootStateType,
  string,
  CreateListActionType
> {
  return async dispatch => {
    const storyDistribution: StoryDistributionWithMembersType = {
      allowsReplies: true,
      id: UUID.generate().toString(),
      isBlockList: false,
      members: memberUuids,
      name,
      senderKeyInfo: undefined,
      storageNeedsSync: true,
      ...(storageServiceDistributionListRecord || {}),
    };

    if (shouldSave) {
      await dataInterface.createNewStoryDistribution(storyDistribution);
    }

    if (storyDistribution.storageNeedsSync) {
      storageServiceUploadJob();
    }

    dispatch({
      type: CREATE_LIST,
      payload: {
        allowsReplies: Boolean(storyDistribution.allowsReplies),
        deletedAtTimestamp: storyDistribution.deletedAtTimestamp,
        id: storyDistribution.id,
        isBlockList: Boolean(storyDistribution.isBlockList),
        memberUuids,
        name: storyDistribution.name,
      },
    });

    return storyDistribution.id;
  };
}

function deleteDistributionList(
  listId: string
): ThunkAction<void, RootStateType, unknown, DeleteListActionType> {
  return async (dispatch, getState) => {
    const deletedAtTimestamp = Date.now();

    const storyDistribution =
      await dataInterface.getStoryDistributionWithMembers(listId);

    if (!storyDistribution) {
      log.warn('No story distribution found for id', listId);
      return;
    }

    await dataInterface.modifyStoryDistributionWithMembers(
      {
        ...storyDistribution,
        deletedAtTimestamp,
        name: '',
        storageNeedsSync: true,
      },
      {
        toAdd: [],
        toRemove: storyDistribution.members,
      }
    );

    const { stories } = getState().stories;
    const storiesToDelete = stories.filter(
      story => story.storyDistributionListId === listId
    );
    await Promise.all(
      storiesToDelete.map(story => deleteStoryForEveryone(stories, story))
    );

    log.info(
      'storyDistributionLists.deleteDistributionList: list deleted',
      listId
    );

    storageServiceUploadJob();

    dispatch({
      type: DELETE_LIST,
      payload: {
        listId,
        deletedAtTimestamp,
      },
    });
  };
}

function modifyDistributionList(
  distributionList: ModifyDistributionListType
): ModifyListActionType {
  return {
    type: MODIFY_LIST,
    payload: distributionList,
  };
}

function hideMyStoriesFrom(
  memberUuids: Array<UUIDStringType>
): ThunkAction<void, RootStateType, null, HideMyStoriesFromActionType> {
  return async dispatch => {
    const myStories = await dataInterface.getStoryDistributionWithMembers(
      MY_STORY_ID
    );

    if (!myStories) {
      log.error(
        'storyDistributionLists.hideMyStoriesFrom: Could not find My Stories!'
      );
      return;
    }

    const toAdd = new Set<UUIDStringType>(memberUuids);

    await dataInterface.modifyStoryDistributionWithMembers(
      {
        ...myStories,
        isBlockList: true,
        storageNeedsSync: true,
      },
      {
        toAdd: Array.from(toAdd),
        toRemove: myStories.members.filter(uuid => !toAdd.has(uuid)),
      }
    );

    storageServiceUploadJob();

    await window.storage.put('hasSetMyStoriesPrivacy', true);

    dispatch({
      type: HIDE_MY_STORIES_FROM,
      payload: memberUuids,
    });
  };
}

function removeMembersFromDistributionList(
  listId: string,
  memberUuids: Array<UUIDStringType>
): ThunkAction<void, RootStateType, null, ModifyListActionType> {
  return async dispatch => {
    if (!memberUuids.length) {
      log.warn(
        'storyDistributionLists.removeMembersFromDistributionList cannot remove a member without uuid',
        listId
      );
      return;
    }

    const storyDistribution =
      await dataInterface.getStoryDistributionWithMembers(listId);

    if (!storyDistribution) {
      log.warn(
        'storyDistributionLists.removeMembersFromDistributionList: No story found for id',
        listId
      );
      return;
    }

    let toAdd: Array<UUIDStringType> = [];
    let toRemove: Array<UUIDStringType> = memberUuids;
    let { isBlockList } = storyDistribution;

    // My Story is set to 'All Signal Connections' or is already an exclude list
    if (
      listId === MY_STORY_ID &&
      (storyDistribution.members.length === 0 || isBlockList)
    ) {
      isBlockList = true;
      toAdd = memberUuids;
      toRemove = [];

      // The user has now configured My Stories
      await window.storage.put('hasSetMyStoriesPrivacy', true);
    }

    await dataInterface.modifyStoryDistributionWithMembers(
      {
        ...storyDistribution,
        isBlockList,
        storageNeedsSync: true,
      },
      {
        toAdd,
        toRemove,
      }
    );

    log.info(
      'storyDistributionLists.removeMembersFromDistributionList: removed',
      {
        listId,
        memberUuids,
      }
    );

    storageServiceUploadJob();

    dispatch({
      type: MODIFY_LIST,
      payload: {
        ...omit(storyDistribution, ['members']),
        isBlockList,
        storageNeedsSync: true,
        membersToAdd: toAdd,
        membersToRemove: toRemove,
      },
    });
  };
}

function setMyStoriesToAllSignalConnections(): ThunkAction<
  void,
  RootStateType,
  null,
  ResetMyStoriesActionType
> {
  return async dispatch => {
    const myStories = await dataInterface.getStoryDistributionWithMembers(
      MY_STORY_ID
    );

    if (!myStories) {
      log.error(
        'storyDistributionLists.setMyStoriesToAllSignalConnections: Could not find My Stories!'
      );
      return;
    }

    if (myStories.isBlockList || myStories.members.length > 0) {
      await dataInterface.modifyStoryDistributionWithMembers(
        {
          ...myStories,
          isBlockList: true,
          storageNeedsSync: true,
        },
        {
          toAdd: [],
          toRemove: myStories.members,
        }
      );

      storageServiceUploadJob();
    }

    await window.storage.put('hasSetMyStoriesPrivacy', true);

    dispatch({
      type: RESET_MY_STORIES,
    });
  };
}

function updateStoryViewers(
  listId: string,
  memberUuids: Array<UUIDStringType>
): ThunkAction<void, RootStateType, null, ViewersChangedActionType> {
  return async dispatch => {
    const storyDistribution =
      await dataInterface.getStoryDistributionWithMembers(listId);

    if (!storyDistribution) {
      log.warn(
        'storyDistributionLists.updateStoryViewers: No story found for id',
        listId
      );
      return;
    }

    const existingUuids = new Set<UUIDStringType>(storyDistribution.members);
    const toAdd: Array<UUIDStringType> = [];

    memberUuids.forEach(uuid => {
      if (!existingUuids.has(uuid)) {
        toAdd.push(uuid);
      }
    });

    const updatedUuids = new Set<UUIDStringType>(memberUuids);
    const toRemove: Array<UUIDStringType> = [];

    storyDistribution.members.forEach(uuid => {
      if (!updatedUuids.has(uuid)) {
        toRemove.push(uuid);
      }
    });

    await dataInterface.modifyStoryDistributionWithMembers(
      {
        ...storyDistribution,
        isBlockList: false,
        storageNeedsSync: true,
      },
      {
        toAdd,
        toRemove,
      }
    );

    storageServiceUploadJob();

    if (listId === MY_STORY_ID) {
      await window.storage.put('hasSetMyStoriesPrivacy', true);
    }

    dispatch({
      type: VIEWERS_CHANGED,
      payload: {
        listId,
        memberUuids,
      },
    });
  };
}

function removeMemberFromAllDistributionLists(
  member: UUIDStringType
): ThunkAction<void, RootStateType, null, ModifyListActionType> {
  return async dispatch => {
    const logId = `removeMemberFromAllDistributionLists(${member})`;
    const lists = await dataInterface.getAllStoryDistributionsWithMembers();

    const listsWithMember = lists.filter(({ members }) =>
      members.includes(member)
    );
    log.info(
      `${logId}: removing ${member} from ${listsWithMember.length} lists`
    );

    for (const { id } of listsWithMember) {
      dispatch(removeMembersFromDistributionList(id, [member]));
    }
  };
}

export const actions = {
  allowsRepliesChanged,
  createDistributionList,
  deleteDistributionList,
  hideMyStoriesFrom,
  modifyDistributionList,
  removeMembersFromDistributionList,
  removeMemberFromAllDistributionLists,
  setMyStoriesToAllSignalConnections,
  updateStoryViewers,
};

export const useStoryDistributionListsActions =
  (): BoundActionCreatorsMapObject<typeof actions> => useBoundActions(actions);

// Reducer

export function getEmptyState(): StoryDistributionListStateType {
  return {
    distributionLists: [],
  };
}

function replaceDistributionListData(
  distributionLists: ReadonlyArray<StoryDistributionListDataType>,
  listId: string,
  getNextDistributionListData: (
    list: StoryDistributionListDataType
  ) => Partial<StoryDistributionListDataType>
): Array<StoryDistributionListDataType> | undefined {
  const listIndex = distributionLists.findIndex(list => list.id === listId);

  if (listIndex < 0) {
    return;
  }

  return replaceIndex(distributionLists, listIndex, {
    ...distributionLists[listIndex],
    ...getNextDistributionListData(distributionLists[listIndex]),
  });
}

export function reducer(
  state: Readonly<StoryDistributionListStateType> = getEmptyState(),
  action: Readonly<StoryDistributionListsActionType>
): StoryDistributionListStateType {
  if (action.type === MODIFY_LIST) {
    const { payload } = action;

    const { membersToAdd, membersToRemove, ...distributionListDetails } =
      payload;

    const listIndex = state.distributionLists.findIndex(
      list => list.id === distributionListDetails.id
    );
    if (listIndex >= 0) {
      const existingDistributionList = state.distributionLists[listIndex];
      const memberUuids = new Set<UUIDStringType>(
        existingDistributionList.memberUuids
      );
      membersToAdd.forEach(uuid => memberUuids.add(uuid));
      membersToRemove.forEach(uuid => memberUuids.delete(uuid));

      return {
        distributionLists: replaceIndex(state.distributionLists, listIndex, {
          ...existingDistributionList,
          ...distributionListDetails,
          memberUuids: Array.from(memberUuids),
        }),
      };
    }

    return {
      distributionLists: [
        ...state.distributionLists,
        {
          ...distributionListDetails,
          memberUuids: membersToAdd,
        },
      ],
    };
  }

  if (action.type === CREATE_LIST) {
    return {
      distributionLists: [...state.distributionLists, action.payload],
    };
  }

  if (action.type === DELETE_LIST) {
    const distributionLists = replaceDistributionListData(
      state.distributionLists,
      action.payload.listId,
      () => ({
        deletedAtTimestamp: action.payload.deletedAtTimestamp,
        memberUuids: [],
        name: '',
      })
    );

    return distributionLists ? { distributionLists } : state;
  }

  if (action.type === HIDE_MY_STORIES_FROM) {
    const distributionLists = replaceDistributionListData(
      state.distributionLists,
      MY_STORY_ID,
      () => ({
        isBlockList: true,
        memberUuids: action.payload,
      })
    );

    return distributionLists ? { distributionLists } : state;
  }

  if (action.type === ALLOW_REPLIES_CHANGED) {
    const distributionLists = replaceDistributionListData(
      state.distributionLists,
      action.payload.listId,
      () => ({
        allowsReplies: action.payload.allowsReplies,
      })
    );

    return distributionLists ? { distributionLists } : state;
  }

  if (action.type === VIEWERS_CHANGED) {
    const distributionLists = replaceDistributionListData(
      state.distributionLists,
      action.payload.listId,
      () => ({
        isBlockList: false,
        memberUuids: Array.from(new Set(action.payload.memberUuids)),
      })
    );

    return distributionLists ? { distributionLists } : state;
  }

  if (action.type === RESET_MY_STORIES) {
    const distributionLists = replaceDistributionListData(
      state.distributionLists,
      MY_STORY_ID,
      () => ({
        isBlockList: true,
        memberUuids: [],
      })
    );

    return distributionLists ? { distributionLists } : state;
  }

  return state;
}
