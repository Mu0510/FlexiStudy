
import * as Alexa from 'ask-sdk-core';

// スキル起動時や「開いて」と言われた時に呼ばれるハンドラ
const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speakOutput = 'こんにちは。じぇみみんのスキルへようこそ。';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput) // ユーザーの応答を待つ場合
      .getResponse();
  }
};

// ヘルプインテントのハンドラ
const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    const speakOutput = 'このスキルでは、音声でチャット入力ができます。何か話してみてください。';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

// キャンセル、ストップインテントのハンドラ
const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
        || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    const speakOutput = 'さようなら。';

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .getResponse();
  }
};

// セッション終了リクエストのハンドラ
const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    console.log(`セッションが終了しました。理由: ${handlerInput.requestEnvelope.request.reason}`);
    return handlerInput.responseBuilder.getResponse();
  }
};

// エラーハンドラ
const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.log(`処理されたエラー: ${error.stack}`);
    const speakOutput = `申し訳ありません、エラーが発生しました。もう一度お試しください。`;

    return handlerInput.responseBuilder
      .speak(speakOutput)
      .reprompt(speakOutput)
      .getResponse();
  }
};

// スキルビルダー
const skillBuilder = Alexa.SkillBuilders.custom();

export const handler = skillBuilder
  .addRequestHandlers(
    LaunchRequestHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(
    ErrorHandler
  )
  .lambda();
