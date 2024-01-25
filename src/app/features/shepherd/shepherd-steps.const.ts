import Step from 'shepherd.js/src/types/step';
import { ShepherdService } from 'angular-shepherd';
import { nextOnObs, twoWayObs, waitForEl } from './shepherd-helper';
import { LayoutService } from '../../core-ui/layout/layout.service';
import { TaskService } from '../tasks/task.service';
import { filter, first, map, startWith } from 'rxjs/operators';
import { promiseTimeout } from '../../util/promise-timeout';
import { Actions, ofType } from '@ngrx/effects';
import { addTask, deleteTask, updateTask } from '../tasks/store/task.actions';
import { GlobalConfigState } from '../config/global-config.model';
import { IS_MOUSE_PRIMARY } from '../../util/is-mouse-primary';
import { hideAddTaskBar } from '../../core-ui/layout/store/layout.actions';
import { NavigationEnd, Router } from '@angular/router';
import Shepherd from 'shepherd.js';
import Tour = Shepherd.Tour;

const NEXT_BTN = {
  classes: 'shepherd-button-primary',
  text: 'Next',
  type: 'next',
};

export const SHEPHERD_STANDARD_BTNS = [
  {
    classes: 'shepherd-button-secondary',
    text: 'Exit Tour',
    type: 'cancel',
  },
  {
    classes: 'shepherd-button-primary',
    text: 'Back',
    type: 'back',
  },
  NEXT_BTN,
];

const CLICK = IS_MOUSE_PRIMARY ? '<em>click</em>' : '<em>tap</em>';
const CLICK_B = IS_MOUSE_PRIMARY ? '<em>Click</em>' : '<em>Tap</em>';

export enum TOUR_ID {
  Welcome = 'Welcome',
  Sync = 'Snyc',
}

export const SHEPHERD_STEPS = (
  shepherdService: ShepherdService,
  cfg: GlobalConfigState,
  actions$: Actions,
  layoutService: LayoutService,
  taskService: TaskService,
  router: Router,
): Array<Step.StepOptions> => {
  return [
    {
      id: TOUR_ID.Welcome,
      title: 'Welcome to Super Productivity!!',
      text: '<p>Super Productivity is a ToDo app that helps you to improve your personal workflows.</p><p>Let`s do a little tour!</p>',
      buttons: [
        {
          classes: 'shepherd-button-secondary',
          text: 'Exit Tour',
          type: 'cancel',
        },
        NEXT_BTN,
      ],
    },
    {
      title: "Let's add your first task!",
      text: IS_MOUSE_PRIMARY
        ? `Click on this button or press <kbd>${cfg.keyboard.addNewTask}</kbd>.`
        : 'Tap on the button with the +',
      attachTo: {
        element: '.tour-addBtn',
        on: 'bottom',
      },
      ...nextOnObs(
        layoutService.isShowAddTaskBar$.pipe(filter((v) => v)),
        shepherdService,
      ),
    },
    {
      title: 'Enter a title!',
      text: 'Enter the title you want to give your task and hit the <kbd>Enter</kbd> key.',
      attachTo: {
        element: 'add-task-bar',
        on: 'bottom',
      },
      beforeShowPromise: () => promiseTimeout(200),
      ...twoWayObs(
        { obs: actions$.pipe(ofType(addTask)) },
        // delay because other hide should trigger first
        { obs: actions$.pipe(ofType(hideAddTaskBar)) },
        shepherdService,
      ),
    },
    {
      title: 'Close the Add Task Bar!',
      text: IS_MOUSE_PRIMARY
        ? 'Press the <kbd>Escape</kbd> key or click anywhere on the grayed out backdrop to leave the add task bar.'
        : 'Tap anywhere on the grayed out backdrop to leave the add task bar.',
      attachTo: {
        element: 'add-task-bar',
        on: 'bottom',
      },
      beforeShowPromise: () => promiseTimeout(200),
      ...nextOnObs(
        actions$.pipe(ofType(hideAddTaskBar)),
        // delay because other hide should trigger first
        shepherdService,
      ),
    },
    {
      title: 'Congrats! This is your first task!',
      text: 'Let`s start tracking time to it!',
      attachTo: {
        element: 'task',
        on: 'bottom' as any,
      },
      when: {
        show: () => {
          setTimeout(() => {
            shepherdService.next();
          }, 3000);
        },
      },
      beforeShowPromise: () => promiseTimeout(200),
    },
    {
      title: 'Time Tracking',
      text: '<p>Time tracking is useful as it allows you to get a better idea on how you spend your time. It will enable you to make better estimates and can improve how you work.</p><p>Pressing the play button in the top right corner will start your first time tracking session.</p>',
      attachTo: {
        element: '.tour-playBtn',
        on: 'bottom',
      },
      ...nextOnObs(
        taskService.currentTaskId$.pipe(filter((id) => !!id)),
        shepherdService,
      ),
    },
    {
      title: 'Stop Tracking Time',
      text: `To stop tracking ${CLICK} on the pause button.`,
      attachTo: {
        element: '.tour-playBtn',
        on: 'bottom',
      },
      beforeShowPromise: () => promiseTimeout(500),
      ...nextOnObs(taskService.currentTaskId$.pipe(filter((id) => !id)), shepherdService),
    },
    ...(IS_MOUSE_PRIMARY
      ? [
          {
            title: 'Edit Task Title',
            text: '<p>You can edit the task title by clicking on it.',
            attachTo: {
              element: '.task-title',
              on: 'bottom' as any,
            },
            ...nextOnObs(actions$.pipe(ofType(updateTask)), shepherdService, () => {}),
          },
          {
            title: 'Task Hover Menu',
            text: 'There is more you you can do with task. Hover over the task you created with your mouse again.',
            attachTo: {
              element: 'task',
              on: 'bottom' as any,
            },
            beforeShowPromise: () => promiseTimeout(500),
            when: {
              show: () => {
                setTimeout(() => {
                  waitForEl('task .hover-controls', () => shepherdService.next());
                }, 3200);
              },
            },
          },
          {
            title: 'Opening Task Side Panel',
            attachTo: {
              element: '.show-additional-info-btn',
              on: 'bottom' as any,
            },
            text: 'You can open a panel with additional controls by clicking on the button.',
            ...nextOnObs(
              taskService.selectedTask$.pipe(filter((selectedTask) => !!selectedTask)),
              shepherdService,
            ),
          },
        ]
      : [
          {
            title: 'Task Side Panel',
            text: 'There is more you you can do with task. Tap on the task.',
            attachTo: {
              element: 'task',
              on: 'bottom' as any,
            },
            ...nextOnObs(
              taskService.selectedTask$.pipe(filter((selectedTask) => !!selectedTask)),
              shepherdService,
            ),
          },
        ]),
    {
      title: 'The Task Side Panel',
      text: 'This is the task side panel.Here you can adjust estimates, schedule your task, add some notes or attachments or configure your task to be repeated.',
      buttons: [NEXT_BTN],
      beforeShowPromise: () => promiseTimeout(500),
    },
    {
      title: 'Closing the Task Side Panel',
      text: IS_MOUSE_PRIMARY
        ? 'You can close the panel by clicking the X. Do this now!'
        : 'You can close the panel by tapping on the X. Do this now!',
      attachTo: {
        element: '.show-additional-info-btn',
        on: 'bottom',
      },
      ...nextOnObs(
        taskService.selectedTask$.pipe(filter((selectedTask) => !selectedTask)),
        shepherdService,
      ),
    },
    {
      title: 'Deleting a Task',
      text: IS_MOUSE_PRIMARY
        ? // eslint-disable-next-line max-len
          `To delete a task you need to open the task context menu. To do so right click (or long press on Mac and Mobile) and select "Delete Task".`
        : 'To delete a task you need to open the task context menu. To do so long press and select "<strong>Delete Task</strong>" in the menu that opens up.',
      attachTo: {
        element: 'task',
        on: 'bottom',
      },
      when: {
        show: () => {
          waitForEl('.mat-menu-panel', () => {
            shepherdService.hide();
          });
          actions$
            .pipe(ofType(deleteTask), first())
            .subscribe(() => shepherdService.next());
        },
      },
    },
    {
      title: 'That covers the basics',
      text: 'Great job! Let`s continue with another subject: <strong>Syncing</strong>!',
      buttons: [NEXT_BTN],
    },
    {
      id: TOUR_ID.Sync,
      title: 'Syncing & Data Privacy',
      text: "<p>Super Productivity takes your data privacy serious. This means that <strong>you decide what will be saved and where</strong>. <strong>The app does NOT collect any data </strong> and there are no user accounts or registration required. It's free and open source and always will be.</p><p>This is important since data is often sold for marketing purposes and leaks happen more often than you would think.</p><p>With Super Productivity you can save and sync your data with a cloud provider of your choosing or even host it in your own cloud.</p><p>Let me show you where to configure this!!</p>",
      buttons: [
        {
          text: 'Skip',
          action: () => {
            shepherdService.show(TOUR_ID.Welcome);
          },
        } as any,
        NEXT_BTN,
      ],
    },
    {
      title: 'Configure Sync',
      attachTo: {
        element: '.tour-burgerTrigger',
        on: 'bottom',
      },
      text: 'Open the menu (<span class="material-icons">menu</span>)',
      ...nextOnObs(
        layoutService.isShowSideNav$.pipe(filter((v) => !!v)),
        shepherdService,
      ),
    },
    {
      title: 'Configure Sync',
      text: `${CLICK_B} on <span class="material-icons">settings</span> <strong>Settings</strong>!`,
      ...nextOnObs(
        router.events.pipe(
          filter((event: any) => event instanceof NavigationEnd),
          map((event) => !!event.url.includes('config')),
          startWith(router.url.includes('config')),
          filter((v) => !!v),
        ),
        shepherdService,
      ),
    },
    {
      title: 'Configure Sync',
      text: `Scroll down and ${CLICK} to expand the <strong>Sync</strong> Section`,
      attachTo: {
        element: '.tour-syncSection',
        on: 'top',
      },
      scrollTo: true,
      when: {
        show: () => {
          waitForEl('.tour-isSyncEnabledToggle', () => shepherdService.next());
        },
      },
    },
    {
      title: 'Configure Sync',
      text: '<p>Here you should be able to configure a sync provider of your choosing. For most people <a href="https://www.dropbox.com/" target="_blank"><strong>Dropbox</strong></a> is probably the easiest solution, that also will offer you automatic backups in the cloud.</p><p>If you have the desktop or Android version of Super Productivity <strong>LocalFile</strong> is another good option. It will let you configure a file path to sync to. You can in turn sync this file with any provider you like.</p><p>The option <strong>WebDAV</strong> can be used to sync with Nextcloud and others.</p>',
      buttons: [NEXT_BTN],
    },
    {
      title: 'Configure Sync',
      text: 'This covers syncing. If you have any questions you can always ask them <a href="https://github.com/johannesjo/super-productivity/discussions">on the projects GitHub page</a>.',
      buttons: [NEXT_BTN],
    },
  ];
};

/*
Or by pressing <kbd>Enter</kbd> when a task is focused with the keyboard which is indicated by a <span class="shepherd-colored">colored border</span>.</p><p>Do this now and <strong>change the title to something else!</strong></p>
 Alternatively you can press the <kbd>➔</kbd> key when a task is focused.

 Alternatively you can focus the task by clicking on it and pressing the <kbd>${cfg.keyboard.taskDelete}</kbd> key

  or by pressing <kbd>←</kbd>
 */
