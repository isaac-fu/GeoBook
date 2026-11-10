import { Kafka } from 'kafkajs';
const kafka = new Kafka({ clientId:'geobook-worker', brokers:(process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',') });
const consumer = kafka.consumer({ groupId:'geobook-notifications' });
await consumer.connect(); await consumer.subscribe({ topic:'geobook.events', fromBeginning:false });
await consumer.run({ eachMessage: async ({ message }) => { const event = JSON.parse(message.value?.toString() ?? '{}'); console.log(`[notification] ${event.type}`, event.booking?.id); } });
