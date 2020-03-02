import axios from "axios";
import { observable, runInAction } from "mobx";
import { window, workspace } from "vscode";
import {
  FollowedUser,
  Gist,
  GistComment,
  GistFile,
  GistShowcaseCategory,
  store
} from ".";
import * as config from "../config";
import { SCRATCH_GIST_NAME, ZERO_WIDTH_SPACE } from "../constants";
import { newTempGist } from "../fileSystem/temp";
import { log } from "../logger";
import {
  byteArrayToString,
  closeGistFiles,
  fileNameToUri,
  isTempGistId,
  openGistFiles,
  sortGists,
  stringToByteArray,
  updateGistTags
} from "../utils";
import { getToken } from "./auth";
import { storage } from "./storage";
import moment = require("moment");

const Gists = require("gists");

export async function getApi(constructor = Gists) {
  const token = await getToken();

  const apiurl = config.get("apiUrl");

  if (!apiurl) {
    const message = "No API URL is set.";
    log.error(message);
    throw new Error(message);
  }

  return new constructor({ apiurl, token });
}

export async function duplicateGist(
  id: string,
  isPublic: boolean = true,
  description?: string,
  saveGist: boolean = true
) {
  const gist = await getGist(id);
  const files = [];
  for (const filename of Object.keys(gist.files)) {
    const content = byteArrayToString(
      await workspace.fs.readFile(fileNameToUri(gist.id, filename))
    );
    files.push({
      filename,
      content
    });
  }

  return newGist(
    files,
    isPublic,
    description || gist.description,
    true,
    saveGist
  );
}

export async function getUser(username: string) {
  const GitHub = require("github-base");
  const api = await getApi(GitHub);

  try {
    const response = await api.get(`/users/${username}`);
    return response.body;
  } catch (e) {
    return null;
  }
}

export async function getUserAvatar(username: string) {
  const user = await getUser(username);
  return user ? user.avatar_url : null;
}

export async function changeDescription(id: string, description: string) {
  const api = await getApi();
  const { body } = await api.edit(id, {
    description
  });

  const gist = store.gists.find((gist) => gist.id === id)!;

  runInAction(() => {
    gist.description = body.description;
    gist.updated_at = body.updated_at;
  });

  updateGistTags(gist);
}

export async function createGistComment(
  id: string,
  body: string
): Promise<GistComment> {
  const api = await getApi();
  const gist = await api.createComment(id, { body });
  return gist.body;
}

export async function deleteGist(id: string) {
  const api = await getApi();
  await api.delete(id);
  store.gists = store.gists.filter((gist) => gist.id !== id);
}

export async function deleteGistComment(
  gistId: string,
  commentId: string
): Promise<void> {
  const api = await getApi();
  await api.deleteComment(gistId, commentId);
}

export async function editGistComment(
  gistId: string,
  commentId: string,
  body: string
): Promise<void> {
  const api = await getApi();
  await api.editComment(gistId, commentId, { body });
}

export async function followUser(username: string) {
  const avatarUrl = await getUserAvatar(username);
  if (!avatarUrl) {
    window.showErrorMessage(
      `"${username}" doesn't appear to be a valid GitHub user. Please try again.`
    );
    return;
  }

  const followedUsers = storage.followedUsers;
  if (followedUsers.find((user) => user === username)) {
    window.showInformationMessage("You're already following this user");
    return;
  } else {
    followedUsers.push(username);
    storage.followedUsers = followedUsers;
  }

  const user: FollowedUser = observable({
    username,
    avatarUrl,
    gists: [],
    isLoading: true
  });

  store.followedUsers.push(user);

  user.gists = await listUserGists(username);
  user.isLoading = false;
}

export async function forkGist(id: string) {
  const api = await getApi();

  const gist = await api.fork(id);
  updateGistTags(gist.body);

  store.gists.unshift(gist.body);

  openGistFiles(gist.body.id);
}

export async function getForks(id: string) {
  const api = await getApi();
  const response = await api.forks(id);

  return response.body.sort(
    (a: Gist, b: Gist) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
  );
}

export async function getGist(id: string): Promise<Gist> {
  const api = await getApi();
  const gist = await api.get(id);
  return observable(gist.body);
}

export async function getGists(ids: string[]): Promise<Gist[]> {
  return Promise.all(ids.map(getGist));
}

export async function getGistComments(id: string): Promise<GistComment[]> {
  if (isTempGistId(id)) {
    return [];
  }

  const api = await getApi();
  const response = await api.listComments(id);
  return response.body;
}

export async function listGists(): Promise<Gist[]> {
  const api = await getApi();
  const { pages } = await api.all();
  const gists: Gist[] = await pages.reduce(
    (result: Gist[], page: any) => [...result, ...page.body],
    []
  );

  return sortGists(gists);
}

export async function listUserGists(username: string): Promise<Gist[]> {
  const api = await getApi();
  const response = await api.list(username);

  return response.body.sort(
    (a: Gist, b: Gist) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
  );
}

export async function newGist(
  gistFiles: GistFile[],
  isPublic: boolean,
  description?: string,
  openAfterCreation: boolean = true,
  saveGist: boolean = true
): Promise<Gist> {
  const { isSignedIn } = store;
  let gist;

  if (!isSignedIn || !saveGist) {
    gist = await newTempGist(gistFiles, isPublic, description);
  } else {
    const api = await getApi();

    const files = gistFiles.reduce((accumulator, gistFile) => {
      return {
        ...accumulator,
        [gistFile.filename!.trim()]: {
          content: gistFile.content || ZERO_WIDTH_SPACE
        }
      };
    }, {});

    const rawGist = await api.create({
      description,
      public: isPublic,
      files
    });
    gist = rawGist.body;
  }

  updateGistTags(gist);

  store.gists.unshift(gist);

  if (openAfterCreation) {
    openGistFiles(gist.id);
  }

  return gist;
}

export async function newScratchNote() {
  const format = config.get("scratchNotes.format");
  const extension = config.get("scratchNotes.extension");
  const filename = `${moment().format(format)}${extension}`;

  if (!store.scratchGist) {
    const api = await getApi();
    const response = await api.create({
      SCRATCH_GIST_NAME,
      public: false,
      files: {
        [filename]: {
          content: ZERO_WIDTH_SPACE
        }
      }
    });

    store.scratchGist = response.body;
  } else {
    await workspace.fs.writeFile(
      fileNameToUri(store.scratchGist.id, filename),
      stringToByteArray("")
    );
  }

  const uri = fileNameToUri(store.scratchGist!.id, filename);
  window.showTextDocument(uri);
}

export async function deleteScratchNote(noteId: string) {
  if (Object.keys(store.scratchGist!.files).length > 1) {
    await workspace.fs.delete(fileNameToUri(store.scratchGist!.id, noteId));
  } else {
    clearScratchNotes();
  }
}

export async function clearScratchNotes() {
  const api = await getApi();
  await api.delete(store.scratchGist!.id);

  closeGistFiles(store.scratchGist!);
  store.scratchGist = null;
}

export async function refreshGists() {
  store.isLoading = true;

  await runInAction(async () => {
    const gists = updateGistTags(await listGists());
    store.scratchGist =
      gists.find((gist) => gist.description === SCRATCH_GIST_NAME) || null;

    store.gists = store.scratchGist
      ? gists.filter((gist) => gist.description !== SCRATCH_GIST_NAME)
      : gists;

    store.starredGists = updateGistTags(await starredGists());

    if (storage.followedUsers.length > 0) {
      store.followedUsers = storage.followedUsers.map((username) => ({
        username,
        gists: [],
        isLoading: true
      }));
    }

    store.isLoading = false;
    if (storage.followedUsers.length > 0) {
      for (const followedUser of store.followedUsers) {
        followedUser.avatarUrl = await getUserAvatar(followedUser.username);
        followedUser.gists = updateGistTags(
          await listUserGists(followedUser.username)
        );
        followedUser.isLoading = false;
      }
    }
  });
}

export async function refreshShowcase() {
  store.showcase.isLoading = true;

  await runInAction(async () => {
    const showcaseUrl = await config.get("showcaseUrl");
    const showcase = await axios.get(showcaseUrl);
    store.showcase.categories = showcase.data.categories.map(
      (category: GistShowcaseCategory) => ({
        title: category.title,
        gists: [],
        _gists: category.gists,
        isLoading: true
      })
    );

    store.showcase.isLoading = false;
    for (const category of store.showcase.categories) {
      // @ts-ignore
      category.gists = updateGistTags(await getGists(category._gists));
      category.isLoading = false;
    }
  });
}

export async function starredGists(): Promise<Gist[]> {
  const api = await getApi();
  const { body } = await api.starred();
  return body;
}

export async function unfollowUser(username: string) {
  storage.followedUsers = storage.followedUsers.filter(
    (user) => user !== username
  );

  store.followedUsers = store.followedUsers.filter(
    (user) => user.username !== username
  );
}

export async function refreshGist(id: string) {
  const gist = await getGist(id);
  const newGists = store.gists.filter((gist) => gist.id !== id);
  newGists.push(gist);

  store.gists = newGists;
}

export async function starGist(gist: Gist) {
  const api = await getApi();
  await api.star(gist.id);

  store.starredGists.push(gist);
}

export async function unstarGist(id: string) {
  const api = await getApi();
  await api.unstar(id);

  store.starredGists = store.starredGists.filter((gist) => gist.id !== id);
}
