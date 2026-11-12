import { ActivityService } from './activity.service.ts';
import type { ServiceContext } from './context.ts';
import { ProjectService } from './project.service.ts';
import { PushService } from './push.service.ts';
import { SettingsService } from './settings.service.ts';
import { TaskService } from './task.service.ts';
import { TimerService } from './timer.service.ts';
import { TokenService } from './token.service.ts';

export interface Services {
  tasks: TaskService;
  projects: ProjectService;
  tokens: TokenService;
  timers: TimerService;
  push: PushService;
  activity: ActivityService;
  settings: SettingsService;
}

export function createServices(ctx: ServiceContext): Services {
  return {
    tasks: new TaskService(ctx),
    projects: new ProjectService(ctx),
    tokens: new TokenService(ctx),
    timers: new TimerService(ctx),
    push: new PushService(ctx),
    activity: new ActivityService(ctx),
    settings: new SettingsService(ctx),
  };
}

export type { ServiceContext } from './context.ts';
export { TaskService, ProjectService, TokenService, TimerService, PushService, ActivityService, SettingsService };
