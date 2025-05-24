# Integrating Twilio with Amazon Nova Sonic speech-to-speech model

## Getting started

### Pre-requisites

#### Local dev
- Install node.js 18+
- Install [localtunnel](https://github.com/localtunnel/localtunnel) to expose local server to the internet `npm i -g localtunnel`
- AWS profile configured with environment variable `AWS_PROFILE` defaulting to `bedrock-test` and region configured via `AWS_REGION` defaulting to `us-east-1`

#### Twilio account
1. Setup a Twilio account. Sign up for [free](https://www.twilio.com/try-twilio)
2. Claim a Twilio Phone number with voice capabilities. [Instructions here](https://help.twilio.com/articles/223135247-How-to-Search-for-and-Buy-a-Twilio-Phone-Number-from-Console)
3. (Optional) A programmable SIP domain to demo escalation to a call center agent. Check [SIP domain section](https://www.twilio.com/en-us/blog/studio-voice-genesys-cloud-account#sip-domain) in this blog

4. Go to account dashboard and capture the **Account SID** . 
We need this to set `TWILIO_ACCOUNT_SID` environment variable.

![Account dashboard](img/tw_account_dashboard.jpg "Twilio Account dashboard")

5. Click on the Generate API keys and capture the newly created API keys.
We need this to update the `TWILIO_API_SID` and `TWILIO_API_SECRET` environemnt variables.

![Generate API Keys](img/tw_api_keys.jpg "Twilio Create API Key")


### Setup

#### Environment variables

- `AWS_PROFILE` - AWS IAM config profile that has necessary permissions for Bedrock models
- `AWS_REGION` - AWS region name
- `TWILIO_ACCOUNT_SID` , `TWILIO_API_SID` & `TWILIO_API_SECRET` - Needed to configure Twilio SDK client
- `TWILIO_FROM_NUMBER` - The Twilio phone number in E.164 format (Needed only for outbound calling demo)
- `TWILIO_VERIFIED_CALLER_ID` - The destination number in E.164 format (Needed only for outbound calling demo). In Twilio trial /sandbox account, the destination number has to be a verified phone number
- `SIP_ENDPOINT` - The Twilio SIP domain endpoint (Needed only if the call should be escalated to human agent)

#### Build & Run
- Clone the library and `cd` into it
- Install the dependencies by running `npm install` 
- Build the app by running `npm run build` 
- Run the command `npm start` to start the webserver that interfaces with Amazon Nova Sonic via Bedrock. **Make sure all the environment variables are set before running this command. Refer to above section for required environment variables specific to the functionality**. 
- In a different terminal, run `lt --port 3000`  to tunnel the app and <u>capture the public endpoint</u>. You could also use ngrok instead. The endpoint looks like `https://<random_domain>.loca.lt` 

> **NOTE:** The use of ngrok or localtunnel is strictly for the demonstration purpose as we intend to run the sample locally and expose it to public internet. When running in production, the application is typically deployed on EC2/ECS/EKS and exposed to internet via an Application Load Balancer. However running the app behind load balancer itself doesn't make it immune to attacks. There should be additional measures like HTTP authentication and request signature validation to make sure the requests are indeed originated from Twilio. For production setup, please refer to Twilio's [secure communication](https://www.twilio.com/docs/usage/security) documentation. 

## Inbound call handling demo

In this section of demo, we'll be making a call to Twilio number and the call will be answered by Amazon Nova Sonic speech-to-speech model

### Configure the incoming call webhook 
In the active phone, go to the corresponding **Voice Configuration** tab and paste the url path webhook for incoming call. In our case, the uri is `incoming-call`, so the path will be `https://<random_domain>.loca.lt/incoming-call` .

![Incoming call webhook](img/tw_phone_incoming.jpg "Configure the webhook for the incoming call")

### Test 
 - Dial the phone number, it will play a welcome message and it connects to the websocket endpoint that connects to Amazon Nova Sonic model
 - All your speech will be handled and responded by Sonic
 - Say something like "I need to cancel my reservation" to invoke the tools 


## Outbound calling demo

In this section of demo, we'll be making outbound calls from a Twilio number to a destination phone number.
When the call is connected, the application instructs Twilio to connect to media streams endpoint to let Amazon Nova Sonic process and answer the call audio.

### Test

- Grab the public endpoint `https://<random_domain>.loca.lt` from the previous "Build & Run" section
- Make sure the `TWILIO_FROM_NUMBER` and `TWILIO_VERIFIED_CALLER_ID` are set to correct phone numbers (E.164 format) before running the app
- Trigger the outbound call using a curl command `curl https://<random_domain>.loca.lt/outbound-call` . The `/outbound-call` endpoint will initiate the call to the destination phone number and also connects to the websocket endpoint that interfaces with Sonic model.


## (Optional) Call forwarding to an agent.

1. Create SIP user credentials to be connected to softphone

![Create SIP credentials](img/tw_sip_user_creds.jpg "Create support agent credentials")

2. Create a SIP domain to forward the calls to a customer support agent. Make sure the user credentials are attached.

![Create SIP domain](img/tw_sip_domain_create.jpg "Create SIP domain")

3. Download a softphone like [Zoiper](https://www.zoiper.com/en/voip-softphone/download/current) and login using the SIP user credentials generated above 

![Soft phone](img/zoiper.jpg "Customer support agent Soft phone")

4. Set the environment variable `SIP_ENDPOINT` to the SIP user (E.g. \<username\>@\<domain\>.sip.twilio.com) and run `npm start` again

5. While on the call, say something like "I need help with billing issues, connect me to an agent" to route the call to the agent. 


## Call Flow

### Inbound calling

#### Invoke webhook on a new incoming call
All incoming calls in Twilio are routed to the webhook, which in our case, is `/incoming-call` and TwiML should be returned with our Websocket endpoint (which is `/media-stream` ) for Twilio media streams to connect to.

![Incoming call webhook](img/01-flow.jpg "Incoming call webhook")


#### Handling call audio using Nova Sonic
Twilio programmable voice API connects to the websocket endpoint and streams the media (the call audio) to it.
The application passes the audio to Nova Sonic speech-to-speech model via Bedrock's bidirectional API. This allows the incoming and outgoing audio to be exchanged asynchronously.
When the Sonic model detects a tool use, the corresponding tool will be invoked and the tool result is passed back to the model.

![Nova Sonic responding to Media streams](img/02-flow.jpg "Nova Sonic responding to Media streams")


#### Escalate the call to a customer support agent
When the Sonic model detects "support" tool use, the current call leg is updated to dial a SIP endpoint.
When an agent is connected to the endpoint using a softphone, that phone will ring.

![Dialing a customer support agent](img/03-flow.jpg "App dialing a customer support agent when support tool is detected")

### Outbound calling

An outbound call needs a trigger to initiate the call from Twilio to a destination phone number. In this sample, the outbound call triggering is exposed via `/outbound-call` endpoint. It leverages Twilio SDK to initiate a call to the destination number and also connect to the media streams websocket endpoint (`/media-stream`). Rest of the call flow will be similar to that of the inbound flow.

![Outbound call flow](img/01-outbound-flow.jpg "Triggering an outbound call and connecting to Amazon Nova Sonic via Twilio media streams endpoint")
