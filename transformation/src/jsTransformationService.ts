import axios from 'axios'
import * as firebase from 'firebase-admin'

import ExecutionResult from './interfaces/executionResult'
import JobResult from './interfaces/jobResult'
import Stats from './interfaces/stats'
import { NotificationRequest, FirebaseParams, SlackParams, WebhookParams } from './interfaces/notificationRequest'

import TransformationService from './interfaces/transformationService'
import SandboxExecutor from './interfaces/sandboxExecutor'
import SlackCallback from './interfaces/slackCallback'
import FcmCallback from './interfaces/fcmCallback'
import WebhookCallback from './interfaces/webhookCallback'

const VERSION = '0.0.2'

export default class JSTransformationService implements TransformationService {
  executor: SandboxExecutor

  constructor (executor: SandboxExecutor) {
    this.executor = executor
  }

  getVersion (): string {
    return VERSION
  }

  private executionTimeInMillis (func: () => ExecutionResult): [number, ExecutionResult] {
    const start = process.hrtime()
    const result = func()
    const hrresult = process.hrtime(start)
    const time = hrresult[0] * 1e3 + hrresult[1] / 1e6
    return [time, result]
  }

  executeJob (code: string, data: object): JobResult {
    const startTimestamp = Date.now()

    const [time, result] = this.executionTimeInMillis(() => this.executor.execute(code, data))

    const endTimestamp = Date.now()

    if (result.error === undefined && (result.data === undefined || result.data === null)) {
      result.data = undefined
      result.error = {
        name: 'MissingReturnError',
        message: 'Code snippet is not returning valid data',
        lineNumber: 0,
        position: 0,
        stacktrace: []
      }
    }

    const stats: Stats = {
      durationInMilliSeconds: time,
      startTimestamp,
      endTimestamp
    }
    const jobResult: JobResult = { ...result, stats }
    return jobResult
  }

  async handleNotification (notificationRequest: NotificationRequest): Promise<void> {
    console.log('NotificationRequest received: ' + JSON.stringify(notificationRequest))
    const conditionHolds = this.executor.evaluate(notificationRequest.condition, notificationRequest.data)
    console.log('Condition is ' + conditionHolds)
    if (!conditionHolds) { // no need to trigger notification
      return Promise.resolve()
    }

    const message = `Pipeline ${notificationRequest.pipelineName}(${notificationRequest.pipelineId}) has new data available.` +
    `Fetch at ${notificationRequest.dataLocation}.`

    switch (notificationRequest.params.type) {
      case 'WEBHOOK':
        await this.handleWebhook(notificationRequest.params, notificationRequest.dataLocation)
        break
      case 'FCM':
        await this.handleFCM(notificationRequest.params, message)
        break
      case 'SLACK':
        await this.handleSlack(notificationRequest.params, message)
        break
      default:
        throw new Error(`Notification type not implemented.`)
    }
  }

  private async handleWebhook (params: WebhookParams, location: string): Promise<void> {
    const callbackObject: WebhookCallback = {
      location,
      timestamp: new Date(Date.now())
    }
    await axios.post(params.url, callbackObject)
  }

  private async handleSlack (params: SlackParams, message: string): Promise<void> {
    const callbackObject: SlackCallback = {
      text: message
    }
    const url = `https://hooks.slack.com/services/${params.workspaceId}/${params.channelId}/${params.secret}`
    await axios.post(url, callbackObject)
  }

  private async handleFCM (params: FirebaseParams, message: string): Promise<void> {
    if(!firebase.app(params.clientEmail)) {
      firebase.initializeApp({
        credential: firebase.credential.cert({
          projectId: params.projectId,
          clientEmail: params.clientEmail,
          privateKey: params.privateKey
        }),
        databaseURL: `https://${params.projectId}.firebaseio.com`
      },
      params.clientEmail)
    }
    const firebaseMessage: FcmCallback = {
      notification: {
        title: 'New Data Available',
        body: message
      },
      data: {
        textfield: 'textvalue'
      },
      topic: params.topic
    }
    const firebaseResponse = await firebase.messaging().send(firebaseMessage)
    console.log(`Firebase message sent to: ${firebaseResponse}`)
  }
}
