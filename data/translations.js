// ====================================================
// Translations - Multiidioma
// ====================================================

const translations = {
  es: {
    greeting: "Hola",
    bookingConfirmed: "Tu reserva está confirmada",
    apartment: "Apartamento",
    checkin: "Entrada",
    checkout: "Salida",
    guests: "Huéspedes",
    adults: "adultos",
    children: "niños",
    registerInstructions: "Para recibir las instrucciones de las llaves, primero completa el registro:",
    afterReg: "Cuando termines, escribe: REGOK",
    regConfirmed: "✅ Registro completado!\n\nAhora revisa los pagos pendientes:\n💰 Depósito de seguridad (según plataforma)\n💰 Impuesto turístico obligatorio",
    afterPay: "Cuando completes el pago, escribe: PAYOK",
    payConfirmed: "✅ Pago confirmado!",
    notFound: "Gracias 🙂\nNo encuentro tu reserva todavía.\nVerifica el número y vuelve a enviar:",
    noBooking: "No encuentro tu reserva. Envía primero:"
  },
  
  en: {
    greeting: "Hello",
    bookingConfirmed: "Your booking is confirmed",
    apartment: "Apartment",
    checkin: "Check-in",
    checkout: "Check-out",
    guests: "Guests",
    adults: "adults",
    children: "children",
    registerInstructions: "To receive the key instructions, first complete the registration:",
    afterReg: "When done, write: REGOK",
    regConfirmed: "✅ Registration completed!\n\nNow review pending payments:\n💰 Security deposit (depending on platform)\n💰 Mandatory tourist tax",
    afterPay: "When payment is complete, write: PAYOK",
    payConfirmed: "✅ Payment confirmed!",
    notFound: "Thank you 🙂\nI can't find your booking yet.\nPlease verify the number and resend:",
    noBooking: "I can't find your booking. First send:"
  },
  
  fr: {
    greeting: "Bonjour",
    bookingConfirmed: "Votre réservation est confirmée",
    apartment: "Appartement",
    checkin: "Arrivée",
    checkout: "Départ",
    guests: "Invités",
    adults: "adultes",
    children: "enfants",
    registerInstructions: "Pour recevoir les instructions des clés, complétez d'abord l'enregistrement:",
    afterReg: "Quand c'est fait, écrivez: REGOK",
    regConfirmed: "✅ Enregistrement terminé!\n\nMaintenant vérifiez les paiements en attente:\n💰 Caution (selon la plateforme)\n💰 Taxe de séjour obligatoire",
    afterPay: "Quand le paiement est terminé, écrivez: PAYOK",
    payConfirmed: "✅ Paiement confirmé!",
    notFound: "Merci 🙂\nJe ne trouve pas encore votre réservation.\nVérifiez le numéro et renvoyez:",
    noBooking: "Je ne trouve pas votre réservation. Envoyez d'abord:"
  },
  
  ru: {
    greeting: "Здравствуйте",
    bookingConfirmed: "Ваше бронирование подтверждено",
    apartment: "Апартамент",
    checkin: "Заезд",
    checkout: "Выезд",
    guests: "Гости",
    adults: "взрослых",
    children: "детей",
    registerInstructions: "Чтобы получить инструкции по ключам, сначала завершите регистрацию:",
    afterReg: "Когда закончите, напишите: REGOK",
    regConfirmed: "✅ Регистрация завершена!\n\nТеперь проверьте ожидающие платежи:\n💰 Депозит (в зависимости от платформы)\n💰 Обязательный туристический налог",
    afterPay: "Когда оплата завершена, напишите: PAYOK",
    payConfirmed: "✅ Оплата подтверждена!",
    notFound: "Спасибо 🙂\nЯ пока не могу найти ваше бронирование.\nПроверьте номер и отправьте снова:",
    noBooking: "Я не могу найти ваше бронирование. Сначала отправьте:"
  }
};

const timeRequestTexts = {
  es: {
    arrivalRequest: "Por favor, indica tu hora de LLEGADA.\n\nEscribe la hora en formato 24h:\nEjemplo: 14:00\n(o simplemente: 14)\n\nCheck-in estándar: {time}",
    arrivalConfirmed: "✅ Hora de llegada: {time}:00\nSuplemento: {price}€",
    standardCheckout: "\n\nAhora tu hora de SALIDA:\nEjemplo: 11\n\nCheck-out estándar: {time}",
    departureConfirmed: "✅ Solicitud recibida!\n\n📅 Entrada: {arrival}:00 ({arrivalPrice}€)\n📅 Salida: {departure}:00 ({departurePrice}€)\n💰 Total suplemento: {total}€\n\nTu solicitud está en revisión.\nRecibirás confirmación pronto.",
    invalidTime: "⚠️ Formato de hora no válido.\nPor favor, escribe la hora en formato 24h (ejemplo: 17:00)"
  },
  
  en: {
    arrivalRequest: "Please indicate your ARRIVAL time.\n\nWrite the time in 24h format:\nExample: 14:00\n(or simply: 14)\n\nStandard check-in: {time}",
    arrivalConfirmed: "✅ Arrival time: {time}:00\nSupplement: {price}€",
    standardCheckout: "\n\nNow your DEPARTURE time:\nExample: 11\n\nStandard check-out: {time}",
    departureConfirmed: "✅ Request received!\n\n📅 Check-in: {arrival}:00 ({arrivalPrice}€)\n📅 Check-out: {departure}:00 ({departurePrice}€)\n💰 Total supplement: {total}€\n\nYour request is under review.\nYou will receive confirmation soon.",
    invalidTime: "⚠️ Invalid time format.\nPlease enter time in 24h format (example: 17:00)"
  },
  
  fr: {
    arrivalRequest: "Veuillez indiquer votre heure d'ARRIVÉE.\n\nÉcrivez l'heure au format 24h:\nExemple: 14:00\n(ou simplement: 14)\n\nEnregistrement standard: {time}",
    arrivalConfirmed: "✅ Heure d'arrivée: {time}:00\nSupplément: {price}€",
    standardCheckout: "\n\nMaintenant votre heure de DÉPART:\nExemple: 11\n\nDépart standard: {time}",
    departureConfirmed: "✅ Demande reçue!\n\n📅 Arrivée: {arrival}:00 ({arrivalPrice}€)\n📅 Départ: {departure}:00 ({departurePrice}€)\n💰 Supplément total: {total}€\n\nVotre demande est en cours d'examen.\nVous recevrez une confirmation bientôt.",
    invalidTime: "⚠️ Format d'heure non valide.\nVeuillez entrer l'heure au format 24h (exemple: 17:00)"
  },
  
  ru: {
    arrivalRequest: "Пожалуйста, укажите время ПРИБЫТИЯ.\n\nНапишите время в формате 24ч:\nПример: 14:00\n(или просто: 14)\n\nСтандартный заезд: {time}",
    arrivalConfirmed: "✅ Время прибытия: {time}:00\nДоплата: {price}€",
    standardCheckout: "\n\nТеперь время ВЫЕЗДА:\nПример: 11\n\nСтандартный выезд: {time}",
    departureConfirmed: "✅ Запрос получен!\n\n📅 Заезд: {arrival}:00 ({arrivalPrice}€)\n📅 Выезд: {departure}:00 ({departurePrice}€)\n💰 Общая доплата: {total}€\n\nВаш запрос рассматривается.\nВы получите подтверждение в ближайшее время.",
    invalidTime: "⚠️ Неверный формат времени.\nПожалуйста, введите время в формате 24ч (пример: 17:00)"
  }
};

module.exports = { translations, timeRequestTexts };
