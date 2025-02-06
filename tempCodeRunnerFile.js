
    // Process general meeting information
    let generalInfoContent = '';
    if (generalInfo) {
      try {
        const generalData = JSON.parse(generalInfo);
        generalInfoContent =
          `Algemene Gegevens:\n` +
          `Datum: ${generalData.meetingDate}\n` +
          `Locatie: ${generalData.meetingLocation}\n` +
          `Deelnemers: ${generalData.participants}\n` +
          `Afwezigen: ${generalData.absentees}\n` +
          `Doel van het gesprek: ${generalData.meetingPurpose}\n` +
          `Vertrouwelijkheid: ${generalData.confidentiality}\n`;
      } catch (err) {
        logger.warn('Error parsing generalInfo; using raw value');
        generalInfoContent = generalInfo;
      }
    }