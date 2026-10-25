/**
 * The game minute at which maps/scripts/MatchTimeLimit.js ends an undecided
 * game, when that trigger script is added (default 90). Set only by
 * -autostart-timelimit (build/petra_ts/match.sh -L); the game setup shows no
 * control for it.
 */
GameSettings.prototype.Attributes.MatchTimeLimit = class MatchTimeLimit extends GameSetting
{
	init()
	{
		this.minutes = undefined;
	}

	toInitAttributes(attribs)
	{
		if (this.minutes !== undefined)
			attribs.settings.MatchTimeLimit = this.minutes;
	}

	fromInitAttributes(attribs)
	{
		this.minutes = this.getLegacySetting(attribs, "MatchTimeLimit");
	}
};
