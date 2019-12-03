// Copyright 2018 Roger Meier <roger@bufferoverflow.ch>
// SPDX-License-Identifier: MIT

import { Callback, IPluginAuth, Logger, PluginOptions, RemoteUser, PackageAccess } from '@verdaccio/types';
import { getInternalError, getUnauthorized, getForbidden } from '@verdaccio/commons-api';
import Gitlab from 'gitlab';

import { UserDataGroups } from './authcache';
import { AuthCache, UserData } from './authcache';

export type VerdaccioGitlabAccessLevel = '$guest' | '$reporter' | '$developer' | '$maintainer' | '$owner';

export type VerdaccioGitlabConfig = {
  url: string;
  authCache?: {
    enabled?: boolean;
    ttl?: number;
  };
  legacy_mode?: boolean;
  publish?: VerdaccioGitlabAccessLevel;
};

export interface VerdaccioGitlabPackageAccess extends PackageAccess {
  name?: string;
  gitlab?: boolean;
}

const ACCESS_LEVEL_MAPPING = {
  $guest: 10,
  $reporter: 20,
  $developer: 30,
  $maintainer: 40,
  $owner: 50,
};

// List of verdaccio builtin levels that map to anonymous access
const BUILTIN_ACCESS_LEVEL_ANONYMOUS = ['$anonymous', '$all'];

// Level to apply on 'allow_access' calls when a package definition does not define one
const DEFAULT_ALLOW_ACCESS_LEVEL = ['$all'];
const DEFAULT_ALLOW_PUBLISH_LEVEL = ['$owned-group'];

export interface VerdaccioGitLabPlugin extends IPluginAuth<VerdaccioGitlabConfig> {
  authCache: AuthCache;
}

export default class VerdaccioGitLab implements VerdaccioGitLabPlugin {
  options: PluginOptions<VerdaccioGitlabConfig>;
  config: VerdaccioGitlabConfig;
  // @ts-ignore
  authCache: AuthCache;
  logger: Logger;
  publishLevel: VerdaccioGitlabAccessLevel;

  constructor(config: VerdaccioGitlabConfig, options: PluginOptions<VerdaccioGitlabConfig>) {
    this.logger = options.logger;
    this.config = config;
    this.options = options;
    this.logger.info(`[gitlab] url: ${this.config.url}`);

    if ((this.config.authCache || {}).enabled === false) {
      this.logger.info('[gitlab] auth cache disabled');
    } else {
      const ttl = (this.config.authCache || {}).ttl || AuthCache.DEFAULT_TTL;
      this.authCache = new AuthCache(this.logger, ttl);
      this.logger.info(`[gitlab] initialized auth cache with ttl: ${ttl} seconds`);
    }

    if (this.config.legacy_mode) {
      this.publishLevel = '$owner';
      this.logger.info('[gitlab] legacy mode pre-gitlab v11.2 active, publish is only allowed to group owners');
    } else {
      this.publishLevel = '$maintainer';
      if (this.config.publish) {
        this.publishLevel = this.config.publish;
      }

      if (!Object.keys(ACCESS_LEVEL_MAPPING).includes(this.publishLevel)) {
        throw Error(`[gitlab] invalid publish access level configuration: ${this.publishLevel}`);
      }
      this.logger.info(`[gitlab] publish control level: ${this.publishLevel}`);
    }
  }

  authenticate(user: string, password: string, cb: Callback) {
    this.logger.trace(`[gitlab] authenticate called for user: ${user}`);

    // Try to find the user groups in the cache
    const cachedUserGroups = this._getCachedUserGroups(user, password);
    if (cachedUserGroups) {
      // @ts-ignore
      this.logger.debug(`[gitlab] user: ${user} found in cache, authenticated with groups:`, cachedUserGroups);
      return cb(null, cachedUserGroups.publish);
    }

    // Not found in cache, query gitlab
    this.logger.trace(`[gitlab] user: ${user} not found in cache`);

    const GitlabAPI = new Gitlab({
      url: this.config.url,
      token: password,
    });

    GitlabAPI.Users.current()
      .then(response => {
        if (user !== response.username) {
          return cb(getUnauthorized('wrong gitlab username'));
        }

        const publishLevelId = ACCESS_LEVEL_MAPPING[this.publishLevel];

        // Set the groups of an authenticated user, in normal mode:
        // - for access, depending on the package settings in verdaccio
        // - for publish, the logged in user id and all the groups they can reach as configured with access level `$auth.gitlab.publish`
        //
        // In legacy mode, the groups are:
        // - for access, depending on the package settings in verdaccio
        // - for publish, the logged in user id and all the groups they can reach as fixed `$auth.gitlab.publish` = `$owner`
        const gitlabPublishQueryParams = this.config.legacy_mode
          ? { owned: true }
          : { min_access_level: publishLevelId };
        // @ts-ignore
        this.logger.trace('[gitlab] querying gitlab user groups with params:', gitlabPublishQueryParams);

        const groupsPromise = GitlabAPI.Groups.all(gitlabPublishQueryParams).then(groups => {
          return groups.filter(group => group.path === group.full_path).map(group => group.path);
        });

        const projectsPromise = GitlabAPI.Projects.all(gitlabPublishQueryParams).then(projects => {
          return projects.map(project => project.path_with_namespace);
        });

        Promise.all([groupsPromise, projectsPromise])
          .then(([groups, projectGroups]) => {
            const realGroups = [user, ...groups, ...projectGroups];
            this._setCachedUserGroups(user, password, { publish: realGroups });

            this.logger.info(`[gitlab] user: ${user} successfully authenticated`);
            // @ts-ignore
            this.logger.debug(`[gitlab] user: ${user}, with groups:`, realGroups);

            return cb(null, realGroups);
          })
          .catch(error => {
            this.logger.error(`[gitlab] user: ${user} error querying gitlab: ${error}`);
            return cb(getUnauthorized('error authenticating user'));
          });
      })
      .catch(error => {
        this.logger.error(`[gitlab] user: ${user} error querying gitlab user data: ${error.message || {}}`);
        return cb(getUnauthorized('error authenticating user'));
      });
  }

  adduser(user: string, password: string, cb: Callback) {
    this.logger.trace(`[gitlab] adduser called for user: ${user}`);
    return cb(null, true);
  }

  changePassword(user: string, password: string, newPassword: string, cb: Callback) {
    this.logger.trace(`[gitlab] changePassword called for user: ${user}`);
    return cb(getInternalError('You are using verdaccio-gitlab integration. Please change your password in gitlab'));
  }

  allow_action(action: "access" | "publish", defaultPermissions: string[]) {
    return (user: RemoteUser, _package: VerdaccioGitlabPackageAccess & PackageAccess, cb: Callback) => {
      if (!_package.gitlab) {
        return cb(null, false);
      }

      const actionValue = _package[action];
      const packageAction = actionValue && actionValue.length > 0 ? actionValue : defaultPermissions;

      this.logger.debug(`[gitlab][${action}] Checking if user can perform action with configuration: "${packageAction.join(', ')}"`)
  
      // Any authenticated used can perform the action
      if (packageAction.includes("$authenticated") && user.name !== undefined) {
        this.logger.debug(`[gitlab][${action}] allow user: ${user.name} authenticated action on package: ${_package.name}`);
        return cb(null, true);
      }

      // Any user can perform the action
      if (BUILTIN_ACCESS_LEVEL_ANONYMOUS.some(level => packageAction.includes(level))) {
        this.logger.debug(`[gitlab][${action}] allow anonymous action on package: ${_package.name}`);
        return cb(null, true);
      }

      // Any authenticated user can perform the action on an owned group
      // Only allow to perform action on packages when:
      //  - the package has exactly the same name as one of the user groups, or
      //  - the package scope is the same as one of the user groups
      if (packageAction.includes("$owned-group")) {
        let packagePermit = false;

        for (const real_group of user.real_groups) {
          // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
          this.logger.trace(
            `[gitlab][${action}]: checking group: ${real_group} for user: ${user.name || ''} and package: ${_package.name}`
          );
    
          if (this._matchGroupWithPackage(real_group, _package.name!)) {
            packagePermit = true;
            break;
          }
        }

        if (packagePermit) {
          this.logger.debug(`[gitlab][${action}] is allowed to access the package: ${_package.name}`);
          return cb(null, true);
        }
      }

      const errorMessages = [
        `The action '${action}' was denied for the user ${user.name || null}.`,
        "Possible causes:",
      ];

      if ((!BUILTIN_ACCESS_LEVEL_ANONYMOUS.some(level => packageAction.includes(level))) && user.name === undefined) {
        errorMessages.push("\t- You are not authenticated.");
      }

      if (packageAction.includes("$owned-group")) {
        errorMessages.push(`\t- You don't have ${this.publishLevel} permission for ${(_package.name || "").replace(/^@/,'')} group or project on Gitlab.`);
      }

      this.logger.debug(`[gitlab][${action}]\n${errorMessages.join('\n')}`);
      return cb(getForbidden(errorMessages.join('\n')));
    }
  }

  allow_access(user: RemoteUser, _package: VerdaccioGitlabPackageAccess & PackageAccess, cb: Callback) {
    return this.allow_action("access", DEFAULT_ALLOW_ACCESS_LEVEL)(user, _package, cb);
  }

  allow_publish(user: RemoteUser, _package: VerdaccioGitlabPackageAccess & PackageAccess, cb: Callback) {
    return this.allow_action("publish", DEFAULT_ALLOW_PUBLISH_LEVEL)(user, _package, cb);
  }

  _matchGroupWithPackage(real_group: string, package_name: string): boolean {
    if (real_group === package_name) {
      return true;
    }

    if (package_name.indexOf('@') === 0) {
      const split_real_group = real_group.split('/');
      const split_package_name = package_name.slice(1).split('/');

      if (split_real_group.length > split_package_name.length) {
        return false;
      }

      for (let i = 0; i < split_real_group.length; i += 1) {
        if (split_real_group[i] !== split_package_name[i]) {
          return false;
        }
      }

      return true;
    }

    return false;
  }

  _getCachedUserGroups(username: string, password: string): UserDataGroups | null {
    if (!this.authCache) {
      return null;
    }
    const userData = this.authCache.findUser(username, password);
    return (userData || {}).groups || null;
  }

  _setCachedUserGroups(username: string, password: string, groups: UserDataGroups): boolean {
    if (!this.authCache) {
      return false;
    }
    this.logger.debug(`[gitlab] saving data in cache for user: ${username}`);
    return this.authCache.storeUser(username, password, new UserData(username, groups));
  }
}
